# Obsyd contracts

Two Soroban contracts, one workspace.

| Package | Contract | What it does |
| --- | --- | --- |
| `obsyd_account` | the wallet | A custom account authenticated by WebAuthn (ES256 / secp256r1) passkey assertions, with expiring session keys, per-token rolling spend caps, guardian recovery behind a timelock, and batched `execute`. |
| `obsyd_factory` | deployment | Counterfactual (`deploy_v2` with `salt = sha256(public_key)`) deployment, so a wallet address is knowable and shareable before it exists on chain. |

Read [`docs/PASSKEY_CONTRACT.md`](../docs/PASSKEY_CONTRACT.md) for the assertion
wire format, nonce semantics, the session denylist, and the recovery flow.
Read [`SECURITY.md`](../SECURITY.md) for the custody boundary with the frontend.

## Layout

```
contracts/
├─ Cargo.toml                 # workspace + release profile (opt-level="z", lto, abort)
├─ obsyd_account/src/
│  ├─ lib.rs                  # __check_auth, admin surface, views
│  ├─ webauthn.rs             # assertion parsing + secp256r1 verification
│  ├─ storage.rs              # DataKey, policy/session/limit/guardian state, TTL
│  └─ test.rs                 # 38 unit tests with real P-256 / ed25519 fixtures
└─ obsyd_factory/src/{lib.rs,test.rs}
```

There is deliberately no `rust-toolchain.toml`: pinning a channel makes `rustup`
re-sync on every invocation on some machines. Use the commands below with your
stable toolchain.

## Build (wasm)

```bash
cd contracts
cargo build --workspace --release --target wasm32v1-none
# target/wasm32v1-none/release/obsyd_account.wasm
# target/wasm32v1-none/release/obsyd_factory.wasm
```

`cargo check --workspace --release --target wasm32v1-none` is the fast gate used
by CI before the real build; it needs the target installed once:

```bash
rustup target add wasm32v1-none
```

## Test

```bash
cd contracts
cargo test --workspace
```

Tests use `soroban-sdk` `testutils` (a dev-dependency) and drive `__check_auth`
through `env.try_invoke_contract_check_auth`, so the assertions are the same
objects a client would send. Real signing comes from `p256` and
`ed25519-dalek` fixtures — no mocks of the cryptography, which is the part that
matters.

Each run also writes `test_snapshots/*.json` — a per-test dump of the ledger the
SDK built. They are derived from `test.rs`, so they are gitignored; delete the
directory freely.

**Locked dependency note.** `soroban-env-host` declares `ed25519-dalek >= 2.0.0`
with no upper bound, and `ed25519-dalek 3.0.0` moved to a `rand_core` release
that `soroban-env-host`'s testutils cannot satisfy — a fresh resolve then fails
to compile `soroban-env-host`. `Cargo.lock` pins `ed25519-dalek` to **2.2.0**;
CI runs `--locked`. If you see the `ChaCha20Rng: CryptoRng` trait error, restore
the pin with:

```bash
cargo update -p ed25519-dalek --precise 2.2.0
```

**Windows note.** On the `x86_64-pc-windows-gnu` toolchain, host linking of a
`cdylib` + `rlib` crate can fail in the PE export table even when the code is
correct; `cargo check --workspace --tests` is the local gate and CI runs the
tests. Use `cargo +stable-x86_64-pc-windows-gnu …` if that is your default host.

## Deploy (testnet)

Requires [Soroban CLI](https://soroban.stellar.org/docs/getting-started/install)
and a funded testnet account.

```bash
cd contracts
cargo build --workspace --release --target wasm32v1-none

ADMIN=$(soroban keys address DEMO)

ACCOUNT=$(soroban contract deploy \
  --wasm target/wasm32v1-none/release/obsyd_account.wasm \
  --source DEMO --network testnet)

# The factory's admin is a constructor argument, so it is bound inside the
# deploy transaction — there is no `initialize` call for someone else to win.
FACTORY=$(soroban contract deploy \
  --wasm target/wasm32v1-none/release/obsyd_factory.wasm \
  --source DEMO --network testnet \
  --constructor-args "$ADMIN")

soroban contract invoke --id $FACTORY --source DEMO --network testnet -- \
  set_wasm_hash --wasm_hash $(shasum -a 256 target/wasm32v1-none/release/obsyd_account.wasm | cut -d' ' -f1)

# An address for a credential, before the wallet exists:
soroban contract invoke --id $FACTORY --source DEMO --network testnet -- \
  preview_address --owner_public_key 04...hex...

# Deploy it:
soroban contract invoke --id $FACTORY --source DEMO --network testnet -- \
  create_account --owner_public_key 04... \
  --rp_id_hash $(sha256 of your rpId) --origin '"obsyd.app"' \
  --require_user_presence --require_user_verification --allow_backup_eligible false
```

Write the addresses into `frontend/wallet/.env.local` as
`NEXT_PUBLIC_OBSYD_ACCOUNT_WASM` / `NEXT_PUBLIC_OBSYD_FACTORY` (see
`.env.example`).

## Conventions for contract PRs

- Every error path gets its own `AccountError` variant — never reuse a variant
  whose name describes a different failure, and never `panic!`/`unwrap!` on
  caller-controlled input.
- Any new state key goes into the `DataKey` enum and is written through
  `write_persistent`, which extends the TTL. Nothing is stored in temporary
  storage.
- If `__check_auth` *reads* a new key, add it to `refresh_passkey_auth` /
  `refresh_session_auth` as well. Only writes extend a lifetime, and the auth
  path otherwise only writes a nonce — so a key that is read but never renewed
  expires a window after deployment, and an expired signer set, policy or spend
  cap cannot be put back.
- A new mutating function is admin-only unless you also decide whether the
  session denylist (`is_admin_fn`) must include it; that decision belongs in the
  PR description.
- Add a test that fails *closed* (wrong RP id, stale nonce, expired lease,
  over-cap spend) alongside any test that passes.
- Assert errors through the generated client's `try_f(..)` twin, never `client.f(..)`:
  for a `-> Result<T, E>` contract function the client's `f` returns `T` and
  **traps** on an error, while `try_f` returns
  `Result<Result<T, _>, Result<E, InvokeError>>`. The test helpers
  `account_error` and `error_of` exist to unwrap that second layer.
- Authorization gating cannot be unit-tested as a contract error: `require_auth`
  of the wrong address fails at the host, so the assertion is that the call
  produces `Err(Err(_))` (an `InvokeError`), not a variant of the error enum.
