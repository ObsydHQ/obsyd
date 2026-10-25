# The passkey wallet contract

`contracts/obsyd_account` is a Soroban **custom account**: it authorises its own
invocations, so a WebAuthn assertion — the thing a fingerprint or Windows Hello
produces — is what moves the funds. `contracts/obsyd_factory` deploys one per
credential and can name the address before it exists.

This document is the wire-format reference. The code is
`obsyd_account/src/{lib,webauthn,storage}.rs`; the tests in `test.rs` build real
P-256 and ed25519 signatures, so every claim here is exercised.

## How an assertion reaches the contract

Soroban asks the account to authorise a transaction by calling

```rust
__check_auth(env, signature_payload: BytesN<32>, signature: Val, auth_contexts: Vec<Context>)
```

`signature_payload` is the host's hash over the authorised tree. It is
*the* challenge: bind the assertion to it and a captured assertion cannot be
replayed onto a different transaction.

The client therefore:

1. asks the wallet contract to authorise `transfer(...)` (or `execute([...])`),
2. simulates, and reads the `SorobanAuthorizationEntry` the host produced,
3. takes `credentials` → the payload hash it must sign,
4. runs `navigator.credentials.get()` with `challenge = that 32-byte hash`,
5. stuffs the resulting assertion into the entry's signature `Val`,
6. signs nothing else — the account contract verifies the assertion.

Steps 4–5 are the client's job today and are the remaining gap in the UI
(see `SECURITY.md`, "Open items").

### Signature `Val`: the `Assertion` struct

```rust
struct Assertion {
    public_key: BytesN<65>,   // SEC1 uncompressed P-256 point: 0x04 ‖ X ‖ Y
    auth_data: Bytes,         // raw authenticatorData from the response
    client_data_json: Bytes,  // raw clientDataJSON
    signature: BytesN<64>,    // r ‖ s, low-s normalised
    nonce: u64,               // the credential's stored counter value
}
```

It is a `#[contracttype]` struct, so the client encodes it as an `ScVal` map with
those keys (`nativeToScVal({publicKey, authData, clientDataJson, signature, nonce}, …)`
with `scBytes`/`u64` types, or by hand via `xdr.ScVal`). `signature` must be 64
bytes **and** low-s: `secp256r1_verify` follows BIP-62 style rules, so a high-s
DER-converted signature fails. Normalise before submitting.

## Verification, in order

`webauthn::verify` fails closed; the first mismatch returns an error and nothing
is written.

| # | Check | Failure |
| --- | --- | --- |
| 1 | `public_key[0] == 0x04`, length 65 | `BadPublicKey` |
| 2 | `auth_data.len() >= 37` | `AuthDataTooShort` |
| 3 | `auth_data[0..32] == policy.rp_id_hash` | `WrongRpId` |
| 4 | UP flag when required (`0x01`) | `UserPresenceRequired` |
| 5 | UV flag when required (`0x02`) | `UserVerificationRequired` |
| 6 | `BE`/`BS` (`0x04`/`0x08`) rejected unless `allow_backup_eligible` | `BackupKeyNotAllowed` |
| 7 | `AT` (`0x40`) must be clear — attested data is for registration | `AuthDataAttested` |
| 8 | `clientDataJSON` contains `"type":"webauthn.get"` | `BadClientData` |
| 9 | contains `"challenge":"<base64url(signature_payload)>"` (43 chars, unpadded) | `ChallengeMismatch` |
| 10 | contains `policy.origin` when the policy pins one | `BadOrigin` |
| 11 | `secp256r1_verify(cred, sha256(auth_data ‖ sha256(client_data_json)), sig)` | host trap |
| 12 | `nonce == stored nonce` (checked before verify, advanced only after it) | `NonceMismatch` |

Checks 8–10 are position-aware substring matches (`"key":"value"`), not a JSON
parse — no parser in a contract, and the `clientDataJSON` shape the browsers
emit is stable. Cross-site iframes are covered by the origin pin plus the
`origin` field the browser itself writes.

`auth_data[33..37]` is the big-endian signature counter. It is read and emitted
as an event but **not** enforced as strictly monotonic: authenticators may clamp
it, and the per-credential nonce already prevents replay.

## Nonce semantics

Each credential (`id = sha256(public_key)`) has its own `u64` nonce, starting at
0. The assertion must carry the current value; after a verified signature the
contract stores `nonce + 1`. So:

- the *first* transaction for a fresh wallet uses `nonce = 0`;
- a client that is unsure of the value reads `passkey_nonce(public_key)`;
- two concurrent transactions from the same credential are impossible by design —
  one of them will hit `NonceMismatch` and should be rebuilt.

Session keys have a separate nonce namespace (`SessionNonce(id)`), so minting or
revoking leases never disturbs passkey counters. `rotate_passkey` gives the new
credential a fresh counter (the old one is deleted with the credential).

## Sessions: scoped, expiring, capped leases

`elevate_session(new_public_key_ed25519, label, ttl_secs)` requires a passkey
ceremony and returns the session id (`sha256(ed25519 key)`). Afterwards the same
wallet accepts, instead of an assertion:

```rust
Vec[ id: BytesN<32>, signature: BytesN<64>, nonce: u64 ]  // ed25519 over signature_payload
```

A session invocation is rejected when the id is unknown (`SessionUnknown`), the
ledger timestamp is past `expires_at` (`SessionExpired`), the nonce is stale, the
signature is invalid, the target function is on the admin denylist, or a token's
rolling cap would be exceeded (`SpendLimitExceeded`). `ttl_secs` is capped at
`MAX_SESSION_TTL` (7 days); `revoke_session(id)` and `revoke_all()` clear them,
and *any* recovery wipes every lease.

The denylist (`is_admin_fn`) blocks: `add_passkey`, `remove_passkey`,
`rotate_passkey`, `set_policy`, `elevate_session`, `revoke_session`,
`revoke_all`, `set_spend_limit`, `clear_spend_limit`, `add_guardian`,
`remove_guardian`, `set_recovery`, `begin_recovery`, `execute_recovery`,
`cancel_recovery`, `upgrade`, `execute`. A stolen laptop with an active lease can
therefore pay out within its caps, but cannot add a passkey, cannot start
recovery, and cannot batch through `execute`.

Spend limits are per token: `set_spend_limit(token, amount, period_secs)` and a
`spent/window_start` window that rolls forward when `now >= window_start +
period_secs`. The charge sums every `transfer` out of the wallet in the authorised
context tree, and an unparseable or negative amount is treated as a refusal
(`SpendLimitExceeded`), never as "nothing to charge". Tokens with no configured
limit are unrestricted — a limit is opt-in per asset.

## Guardian recovery

Set up (owner, passkey): `add_guardian(address)` ×N, then
`set_recovery(threshold, timelock_secs)` with `timelock_secs ≥ 3600`.

Lost the passkey:

```
begin_recovery(new_public_key)   // permissionless; queues, blocks if one is pending
   ... wait timelock_secs ...
execute_recovery([guardian, …])  // needs `threshold` distinct registered guardians,
                                 // each proving control with require_auth
```

`execute_recovery` replaces the *entire* credential set with the single new key,
revokes all sessions, clears the pending request and emits `rec_done`.
`cancel_recovery` (owner-signed) drops a pending request. Guards worth naming:
duplicate guardians are rejected at `add_guardian`; `begin_recovery` refuses while
another is pending (`RecoveryInProgress`); `execute_recovery` requires quorum
(`QuorumNotMet`), rejects a signer that is not a guardian (`NotAGuardian`), and
refuses before the timelock elapses (`TimelockNotElapsed`). The timelock is what
makes a stolen guardian set useless without also stealing time.

## Batching: `execute`

`execute(Vec<InvokerContractAuthEntry>)` authorises and runs a tree of calls as
the wallet itself — the primitive a swap needs (`approve` on the token, then
`swap_exact_tokens_for_tokens` on the router, atomically). Because the tree *is*
the authorised argument, it is inside the WebAuthn challenge; the prompt cannot
be re-pointed at different calls after the user confirmed. Entries that are not
contract invocations return `BadArgs` rather than being silently skipped.

## Factory: an address before the wallet exists

`create_account(owner_public_key, rp_id_hash, origin, require_up, require_uv,
allow_backup)` deploys with

```rust
env.deployer().with_current_contract(sha256(owner_public_key)).deploy_v2(wasm_hash, (…))
```

so the resulting address is a function of the credential and the factory
address. `preview_address(public_key)` computes the same value without a
transaction (counterfactual deployment), which is why onboarding can show a
deposit address before anything is on chain. `register_account` lets an
administratively deployed wallet join the registry; `accounts`/`address_of`/
`count` are views.

Both contracts take their identity from `__constructor`, i.e. from the arguments
of the deploy transaction itself, and the host reserves `__`-prefixed functions
against direct calls. So there is no window in which a pending wallet can be
claimed, no later call can re-point a live wallet at somebody else's credential,
and nobody can win an `initialize` race to become the factory's admin. The admin
recorded at factory deployment is what gates `set_wasm_hash`, `set_admin` and
`register_account`; the approved build is pinned by that admin, never by the
caller of `create_account`.

## Storage and TTL

All state is persistent under one `DataKey` enum. Every write extends the entry
to `ledger.sequence + 40_000` with a `+ 20_000` threshold — near the testnet
maximum for a single extension.

Reads that gate authorization renew as well. `__check_auth` decides from the
signer set, the policy, the spend caps and the recovery configuration, and then
writes only a nonce — and only writes extend a lifetime. So both auth paths end
with a refresh of exactly the state the decision consumed
(`refresh_passkey_auth` / `refresh_session_auth` in `storage.rs`); without it an
idle-but-live wallet would forget its own passkeys a window after deployment, an
unused cap would lapse into *no cap*, and no call can put either back. The
factory renews its admin and pinned build as it deploys wallets. There is no
temporary state.

## Building and testing

```bash
cd contracts
cargo +stable-x86_64-pc-windows-gnu check --workspace --release --target wasm32v1-none
cargo test --workspace           # needs a host-linkable toolchain; CI runs this
soroban contract build --package obsyd_account --release
```

`cargo test` needs the `testutils` feature (already a dev-dependency) and links
real `p256`/`ed25519-dalek` fixtures; on some Windows toolchains host linking
fails for `cdylib`+`rlib` crates, which is why CI, not the local check, is the
test gate. See `contracts/README.md`.
