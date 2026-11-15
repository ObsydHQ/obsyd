# Obsyd Audit Scope & Build Reproduction Guide

This document defines the exact files, lines of code, build reproduction steps, and known pre-mainnet issues for security auditors reviewing **Obsyd**.

Related documents:
- [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) â€” Assets, actors, trust boundaries, STRIDE analysis, and full invariants-to-test matrix
- [`SECURITY.md`](../SECURITY.md) â€” Security policy, HTTP custody boundary table, and vulnerability disclosure process
- [`docs/PASSKEY_CONTRACT.md`](./PASSKEY_CONTRACT.md) â€” WebAuthn wire format and contract storage design

---

## 1. In-Scope Components & Files

### 1.1 Soroban Smart Contracts (`contracts/`)

The primary audit target is the Rust Soroban workspace (`soroban-sdk = "22.0.11"`, target `wasm32v1-none`):

| Crate | File | Purpose & Critical Entry Points |
| :--- | :--- | :--- |
| `obsyd_account` | `contracts/obsyd_account/src/lib.rs` | Custom account contract (`__constructor`, `__check_auth`, `is_admin_fn`, `outgoing_for`, passkey management, session elevation/revocation, spend limits, timelocked guardian recovery, batched `execute`, and `upgrade`) |
| `obsyd_account` | `contracts/obsyd_account/src/webauthn.rs` | On-chain WebAuthn assertion parser and verifier (`Assertion`, `base64url_32`, `json_string`, `verify` with `secp256r1_verify`) |
| `obsyd_account` | `contracts/obsyd_account/src/storage.rs` | Persistent `DataKey` layout, rolling `SpendLimit` charging (`try_charge`), and TTL renewal (`refresh_passkey_auth`, `refresh_session_auth`, `EXTEND_TO = 40_000`) |
| `obsyd_factory` | `contracts/obsyd_factory/src/lib.rs` | Counterfactual wallet deployer (`__constructor`, `set_wasm_hash`, `set_admin`, `preview_address`, `create_account`, `register_account`, and registry views) |

### 1.2 Frontend Custody Boundary (`frontend/wallet/`)

| File | Security Role |
| :--- | :--- |
| `frontend/wallet/lib/custody.ts` | Server-side request body guard (`refuse()`, `ALLOWED_FIELDS`, secret seed regex rejection) |
| `frontend/wallet/lib/soroban.ts` | Isomorphic transaction builder, simulator, and client-side signer (zero `node:fs` or server secret access) |
| `frontend/wallet/lib/passkey.ts` | Browser WebAuthn credential creation, COSE P-256 public key extraction, and base64url helpers |
| `frontend/wallet/lib/wallet.ts` | Isolated browser device-key reader/writer |
| `frontend/wallet/next.config.js` | Content Security Policy (`connect-src`, `script-src`, `frame-ancestors 'none'`) and security headers |
| `frontend/wallet/app/api/**/route.ts` | Next.js API routes (`/api/send`, `/api/tx/submit`, `/api/swap/quote`, `/api/swap/faucet`, `/api/fund`, `/api/balance`) |

### 1.3 Out of Scope

- `.reference/` (gitignored third-party study checkouts)
- Presentational React components under `frontend/wallet/components/` and CSS styles (`frontend/wallet/app/globals.css`) that do not handle key material or construct network requests

---

## 2. Reproducible Build & Verification Steps

### 2.1 Toolchain Requirements

- **Rust**: Stable toolchain with `wasm32v1-none` target (`rustup target add wasm32v1-none`)
- **Locked Cargo Dependencies**: `contracts/Cargo.lock` pins `ed25519-dalek` to `2.2.0` for `soroban-env-host` `testutils` compatibility (`contracts/README.md`). Always pass `--locked` to `cargo`.
- **Node.js**: Node.js 20 LTS (`npm ci` from repository root)

### 2.2 Building the Deployable WASM Binaries

```bash
cd contracts
cargo build --locked --workspace --release --target wasm32v1-none
```

This produces:
- `contracts/target/wasm32v1-none/release/obsyd_account.wasm`
- `contracts/target/wasm32v1-none/release/obsyd_factory.wasm`

To compute the SHA-256 digests pinned by `ObsydFactory::set_wasm_hash`:

```bash
shasum -a 256 contracts/target/wasm32v1-none/release/obsyd_account.wasm \
              contracts/target/wasm32v1-none/release/obsyd_factory.wasm
```

### 2.3 Running the Verification Suites

1. **Contract Unit & Cryptography Tests** (40 tests in `obsyd_account`, 10 tests in `obsyd_factory` using real `p256` and `ed25519-dalek` signatures):
   ```bash
   cd contracts
   cargo test --locked --workspace
   ```
2. **Frontend Custody & Unit Tests**:
   ```bash
   npm run typecheck
   npm test
   npm run lint
   ```
3. **Live Testnet Passkey Proof** (deploys factory + account, creates a WebAuthn passkey in headless Chromium via CDP, executes a passkey-authorized transfer, and verifies `NonceMismatch` and `ChallengeMismatch` rejections on Stellar testnet):
   ```bash
   node frontend/wallet/scripts/passkey-live.mjs
   ```

---

## 3. Known Issues & Focus Areas for Auditors

1. **Custom `clientDataJSON` Field Scanner (`contracts/obsyd_account/src/webauthn.rs:148-176`)**:
   - `json_string` extracts top-level `"type"`, `"challenge"`, and `"origin"` string values without a full JSON parser. Auditors should verify that crafted `clientDataJSON` payloads (such as escaped quotes or nested keys) cannot spoof `"type":"webauthn.get"`, `"challenge"`, or `"origin"` while still passing `secp256r1_verify`.
2. **Session Outgoing Transfer Accounting (`contracts/obsyd_account/src/lib.rs:132-162`)**:
   - `outgoing_for` inspects `Context::Contract` entries matching `fn_name == "transfer"` and `args.len() == 3` where `args[0] == wallet`. Auditors should verify whether any SEP-41 / Stellar Asset Contract method (e.g. `burn` or `transfer_from`) could move funds under a session key without being counted against `SpendLimit`.
3. **Uncapped Owner `upgrade` and `execute` (`contracts/obsyd_account/src/lib.rs:641-682`)**:
   - Both require owner passkey authorization (`is_admin_fn` blocks sessions), but `upgrade` has no timelock delay and `execute` does not restrict target contract addresses.
4. **Single-Step Factory Admin Transfer (`contracts/obsyd_factory/src/lib.rs:197-201`)**:
   - `set_admin` replaces `DataKey::Admin` in one step without a pending-acceptance handshake or event emission.
5. **UI Passkey Contract Integration (#2)**:
   - The Next.js UI currently signs demo transactions with a `localStorage` Ed25519 key (`lib/wallet.ts`), whereas the full passkey contract flow is exercised in `frontend/wallet/scripts/passkey-live.mjs`.
