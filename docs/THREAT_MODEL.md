# Obsyd Threat Model & Invariants Matrix

This document defines the assets, actors, trust boundaries, STRIDE threat analysis, and complete invariant-to-test mapping for the **Obsyd** passkey smart-contract wallet (`contracts/obsyd_account`, `contracts/obsyd_factory`, and `frontend/wallet`).

Related documents:
- [`SECURITY.md`](../SECURITY.md) â€” Vulnerability reporting, HTTP custody boundary, and CSP defences
- [`docs/AUDIT_SCOPE.md`](./AUDIT_SCOPE.md) â€” In-scope files, reproducible build instructions, and known issues
- [`docs/PASSKEY_CONTRACT.md`](./PASSKEY_CONTRACT.md) â€” WebAuthn assertion wire format and storage layout

---

## 1. Assets, Actors, and Trust Boundaries

### 1.1 Protected Assets

| Asset | Location | Security Impact if Compromised |
| :--- | :--- | :--- |
| **User Wallet Funds (XLM & SAC Tokens)** | Held by each deployed `obsyd_account` contract instance | Direct loss of user funds if unauthorized transfers or arbitrary `execute` batches are permitted |
| **Wallet Signer Set & Security Policy** | Persistent storage in `obsyd_account` (`DataKey::Passkey`, `PasskeyIds`, `Policy`, `Limit`, `Guardians`, `RecoveryParams`) | Unauthorized takeover, replay of spent assertions, or silent expiration of spend caps / passkeys |
| **Factory Admin & Pinned WASM Hash** | Persistent storage in `obsyd_factory` (`DataKey::Admin`, `DataKey::WasmHash`, `DataKey::Registry`) | Deployment of unreviewed wallet bytecode for future users or corruption of the credential-to-address registry |
| **Client Credential Material** | Browser WebAuthn authenticator (`P-256` passkey) / session `ed25519` lease / demo `localStorage` seed | Unauthorized transaction signing if leaked or hijacked via XSS |
| **Testnet Demo Treasury Key** | Server-side `frontend/wallet/scripts/pool.json` (gitignored, read only by `lib/swap.ts`) | Draining of testnet-only demo faucet tokens (`OBA`/`OBB`) |

### 1.2 Actors & Trust Assumptions

| Actor | Privilege Level | Trust Assumption |
| :--- | :--- | :--- |
| **Wallet Owner (Passkey Holder)** | Full owner authority over their `obsyd_account` via WebAuthn `P-256` (`secp256r1`) assertions | Trusted root of authority for that wallet; hardware/platform authenticator enforces user presence (`UP`) and user verification (`UV`) |
| **Session-Key Holder** | Scoped temporary `ed25519` lease (`<= 7 days`) | **Semi-trusted / potentially compromised device**: permitted to authorize ordinary token transfers within rolling `SpendLimit` caps, but strictly forbidden from all 17 admin/control entry points (`is_admin_fn`) |
| **Guardians** | Pre-registered Stellar addresses (`DataKey::Guardians`) | **Individually untrusted, collectively trusted up to `threshold` after `timelock_secs` (`>= 3600s`)**: cannot act alone below quorum and cannot bypass the recovery timelock |
| **Relayer / Next.js API Server** | Untrusted transaction builder and fee payer (`/api/send`, `/api/tx/submit`) | **Untrusted for custody**: builds unsigned XDR and relays signed envelopes; never receives or holds user secret keys (`lib/custody.ts` `refuse()`) |
| **Soroban RPC & Horizon** | Network transport and simulation providers | **Untrusted for authorization**: can withhold liveness or return forged simulation data, but cannot forge a passkey assertion over `signature_payload` |
| **Factory Admin** | Privileged deployer recorded in `obsyd_factory::__constructor` | Trusted to pin the audited `obsyd_account` WASM hash (`set_wasm_hash`), register out-of-band accounts (`register_account`), and rotate admin (`set_admin`) |

### 1.3 Trust Boundaries Diagram

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ TB-1: Authenticator Hardware / OS Enclave                                   â”‚
â”‚   â€¢ P-256 private key never leaves authenticator                            â”‚
â”‚   â€¢ Signs sha256(authData â€– sha256(clientDataJSON))                         â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                       â”‚ WebAuthn navigator.credentials.get()
                                       â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ TB-2: Browser Client (frontend/wallet â€” CSP & Local Custody Boundary)       â”‚
â”‚   â€¢ lib/passkey.ts / lib/soroban.ts / lib/wallet.ts                         â”‚
â”‚   â€¢ Assembles SorobanAuthorizationEntry signature locally                   â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                   â”‚ Unsigned / Signed XDR only            â”‚ Direct RPC calls
                   â”‚ (refuse() blocks secret seeds)        â”‚
                   â–¼                                       â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ TB-3: Next.js API (Untrusted Relay)  â”‚ â”‚ TB-4: Stellar Soroban On-Chain VM  â”‚
â”‚   â€¢ /api/send (unsigned XDR)         â”‚ â”‚   â€¢ obsyd_factory (deploy_v2)      â”‚
â”‚   â€¢ /api/tx/submit (signed XDR)      â”‚ â”‚   â€¢ obsyd_account (__check_auth)   â”‚
â”‚   â€¢ /api/swap/faucet (testnet-gated) â”‚ â”‚   â€¢ Soroswap / SAC token contracts â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## 2. STRIDE Threat Analysis per Trust Boundary

| Boundary | Threat (STRIDE) | Attack Vector | Mitigation |
| :--- | :--- | :--- | :--- |
| **TB-1 â†’ TB-2** (Authenticator to Browser) | **Spoofing / Tampering** | Attacker supplies a registration ceremony (`webauthn.create`), attested credential data (`AT` flag), wrong `rpIdHash`, or a cross-origin phishing assertion. | `webauthn::verify` checks `rp_id_hash` (`WrongRpId`), `UP`/`UV` flags, rejects `BE`/`BS` unless `allow_backup_eligible` (`BackupKeyNotAllowed`), rejects `AT` (`AuthDataAttested`), requires `"type":"webauthn.get"` (`BadClientData`), and verifies `"origin"` (`BadOrigin`). |
| **TB-2 â†’ TB-3** (Browser to Next.js API) | **Information Disclosure** | Buggy client code accidentally sends a secret seed (`S...`) or extra fields in an HTTP POST body; or XSS exfiltrates `localStorage` to an attacker server. | Every POST route calls `refuse()` (`lib/custody.ts`), rejecting unknown keys and `S[A-Z2-7]{55}` seeds with HTTP 400. Strict CSP `connect-src` in `next.config.js` restricts outbound connections to self, Horizon, Soroban RPC, and Friendbot. |
| **TB-3 â†’ TB-4** (Relayer / Network to Chain) | **Replay & Repudiation** | Malicious relayer replays a captured WebAuthn assertion or re-points a signed assertion at a different recipient/amount. | `challenge` must equal `base64url(signature_payload)` (`ChallengeMismatch`), binding the signature to the exact Soroban authorization tree, and per-credential/per-session nonces increment atomically (`NonceMismatch`). |
| **TB-4** (`obsyd_account` Session Path) | **Elevation of Privilege** | Compromised session key attempts to add a passkey, alter spend limits, start/execute recovery, upgrade the contract, or batch admin calls through `execute`. | `__check_auth` rejects non-contract contexts and blocks all 17 privileged functions via `is_admin_fn` (`ForbiddenForSession`), including `execute` and `upgrade`, before charging per-token `SpendLimit` windows (`SpendLimitExceeded`). |
| **TB-4** (`obsyd_account` Recovery & Storage) | **Denial of Service / Takeover** | Attacker front-runs wallet initialization, removes the final passkey, submits duplicate guardians to reach quorum early, or waits for persistent storage TTLs to expire. | Initialization occurs inside `__constructor` during counterfactual `deploy_v2`; `remove_passkey` refuses when `passkey_count <= 1` (`LastPasskey`); `execute_recovery` enforces `timelock_secs >= 3600`, deduplicates signers (`DuplicateGuardian`), and checks `require_auth()`; both auth paths call `refresh_passkey_auth` / `refresh_session_auth` to extend TTLs by `40,000` ledgers. |

---

## 3. Invariants Matrix

### 3.1 Session Denylist Invariants (`is_admin_fn` in `contracts/obsyd_account/src/lib.rs:99-125`)

Every entry in `is_admin_fn` is forbidden to session keys (`AccountError::ForbiddenForSession`) and verified in `contracts/obsyd_account/src/test.rs::a_session_key_cannot_touch_any_admin_function`:

| # | `is_admin_fn` Entry | Purpose | Session Denylist Test (`contracts/obsyd_account/src/test.rs`) | Functional / Negative Unit Test (`contracts/obsyd_account/src/test.rs`) |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `add_passkey` | Register an additional P-256 passkey | `test::a_session_key_cannot_touch_any_admin_function` | `test::a_second_registered_passkey_can_authorize`, `test::a_duplicate_passkey_is_rejected` |
| 2 | `remove_passkey` | Remove a registered passkey (cannot remove last) | `test::a_session_key_cannot_touch_any_admin_function` | `test::the_last_passkey_cannot_be_removed` |
| 3 | `rotate_passkey` | Swap an existing passkey for a new one and revoke sessions | `test::a_session_key_cannot_touch_any_admin_function` | `test::rotating_the_key_keeps_the_address_and_drops_leases` |
| 4 | `set_policy` | Update RP id hash, origin, and UP/UV/backup flags | `test::a_session_key_cannot_touch_any_admin_function` | `test::a_policy_can_admit_synced_credentials` |
| 5 | `elevate_session` | Mint a temporary `ed25519` session lease (`<= 7 days`) | `test::a_session_key_cannot_touch_any_admin_function` | `test::an_elevated_session_key_authorizes_ordinary_calls`, `test::an_overlong_session_lease_is_refused` |
| 6 | `revoke_session` | Revoke a single session lease by ID | `test::a_session_key_cannot_touch_any_admin_function` | `test::a_session_can_be_revoked` |
| 7 | `revoke_all` | Revoke all active session leases | `test::a_session_key_cannot_touch_any_admin_function` | `untested (direct call; helper exercised by test::rotating_the_key_keeps_the_address_and_drops_leases)` |
| 8 | `set_spend_limit` | Configure per-token rolling spend cap for sessions | `test::a_session_key_cannot_touch_any_admin_function` | `test::a_spend_limit_caps_session_transfers`, `test::a_passkey_is_exempt_from_spend_limits` |
| 9 | `clear_spend_limit` | Remove a per-token spend limit | `test::a_session_key_cannot_touch_any_admin_function` | `untested (direct call; denylist enforced in test::a_session_key_cannot_touch_any_admin_function)` |
| 10 | `add_guardian` | Register a recovery guardian address | `test::a_session_key_cannot_touch_any_admin_function` | `test::guardian_quorum_recovers_the_wallet_after_the_timelock` |
| 11 | `remove_guardian` | Remove a registered guardian address | `test::a_session_key_cannot_touch_any_admin_function` | `untested (direct call; denylist enforced in test::a_session_key_cannot_touch_any_admin_function)` |
| 12 | `set_recovery` | Configure guardian quorum `threshold` and `timelock_secs >= 3600` | `test::a_session_key_cannot_touch_any_admin_function` | `test::guardian_quorum_recovers_the_wallet_after_the_timelock` |
| 13 | `begin_recovery` | Queue a pending recovery request | `test::a_session_key_cannot_touch_any_admin_function` | `test::guardian_quorum_recovers_the_wallet_after_the_timelock`, `test::recovery_needs_no_owner_authorization_but_configuration_does` |
| 14 | `execute_recovery` | Finalize recovery with `threshold` guardian signatures after timelock | `test::a_session_key_cannot_touch_any_admin_function` | `test::guardian_quorum_recovers_the_wallet_after_the_timelock`, `test::recovery_refuses_a_short_quorum` |
| 15 | `cancel_recovery` | Cancel a pending recovery request (owner-signed) | `test::a_session_key_cannot_touch_any_admin_function` | `test::the_owner_can_cancel_a_pending_recovery` |
| 16 | `execute` | Authorize and invoke a batch of sub-contract calls as the wallet | `test::a_session_key_cannot_touch_any_admin_function` | `untested (direct unit call; denylist enforced in test::a_session_key_cannot_touch_any_admin_function)` |
| 17 | `upgrade` | Replace contract WASM code in-place (`update_current_contract_wasm`) | `test::a_session_key_cannot_touch_any_admin_function` | `untested (direct unit call; denylist enforced in test::a_session_key_cannot_touch_any_admin_function)` |

### 3.2 `AccountError` Variants Matrix (`contracts/obsyd_account/src/lib.rs:57-88`)

| Code | `AccountError` Variant | Invariant Enforced | Verifying Test (`contracts/obsyd_account/src/test.rs`) |
| :--- | :--- | :--- | :--- |
| `1` | `NotInitialized` | Uninitialized wallet rejects `__check_auth` and `begin_recovery` | `untested (unreachable on deployed wallets because __constructor sets Initialized at deploy; see test::a_live_wallet_cannot_be_re_initialized_by_anyone_else)` |
| `2` | `AlreadyInitialized` | Reserved variant for initialization guard (`__constructor` is host-reserved against re-invocation) | `test::a_live_wallet_cannot_be_re_initialized_by_anyone_else` (host traps on direct `__constructor` call) |
| `3` | `BadPublicKey` | P-256 public key must be 65 bytes starting with `0x04` (uncompressed SEC1 point) | `untested in obsyd_account/src/test.rs (exercised in obsyd_factory/src/test.rs::a_malformed_public_key_is_refused)` |
| `4` | `AuthDataTooShort` | WebAuthn `authenticatorData` must be at least 37 bytes (`rpIdHash` + `flags` + `counter`) | `test::truncated_auth_data_is_rejected` |
| `5` | `AuthDataAttested` | Assertion `authData` must not have the `AT` (`0x40`) attested credential flag set | `test::an_attested_ceremony_is_rejected` |
| `6` | `WrongRpId` | `authData[0..32]` must equal `policy.rp_id_hash` | `test::an_assertion_for_another_relying_party_is_rejected` |
| `7` | `UserPresenceRequired` | `authData` flags must include `UP` (`0x01`) when `policy.require_user_presence` is true | `test::user_presence_is_required` |
| `8` | `UserVerificationRequired` | `authData` flags must include `UV` (`0x04`) when `policy.require_user_verification` is true | `test::user_verification_is_required_when_policy_says_so`, `test::the_reserved_bit_is_not_user_verification` |
| `9` | `BackupKeyNotAllowed` | `BE` (`0x08`) and `BS` (`0x10`) flags are rejected unless `policy.allow_backup_eligible` is true | `test::a_backed_up_credential_is_rejected_by_default`, `test::a_cloud_synced_credential_is_rejected_by_default` |
| `10` | `BadClientData` | `clientDataJSON` must contain `"type":"webauthn.get"` and valid string fields | `test::a_registration_ceremony_is_rejected` |
| `11` | `ChallengeMismatch` | `clientDataJSON.challenge` must equal `base64url(signature_payload)` | `test::an_assertion_for_another_transaction_is_rejected` |
| `12` | `BadOrigin` | `clientDataJSON.origin` must equal `policy.origin` when non-empty | `test::a_pinned_origin_must_match` |
| `13` | `UnknownPasskey` | Assertion or removal must reference a registered credential in `DataKey::Passkey` | `test::an_unregistered_passkey_is_rejected` |
| `14` | `PasskeyExists` | `add_passkey` and `rotate_passkey` reject already-registered credentials | `test::a_duplicate_passkey_is_rejected` |
| `15` | `LastPasskey` | `remove_passkey` refuses to remove the final remaining passkey (`passkey_count <= 1`) | `test::the_last_passkey_cannot_be_removed` |
| `16` | `NonceMismatch` | Assertion or session nonce must match `DataKey::PasskeyNonce` / `SessionNonce` | `test::the_same_assertion_cannot_be_replayed` |
| `17` | `InvalidSignature` | Signature `Val` must decode as either `Assertion` or `[BytesN<32>, BytesN<64>, u64]` | `test::an_unparseable_signature_is_rejected` |
| `18` | `SessionUnknown` | Session ID must exist in `DataKey::Session` | `test::an_unknown_session_id_is_rejected`, `test::a_session_can_be_revoked` |
| `19` | `SessionExpired` | Session requires `env.ledger().timestamp() < session.expires_at` | `test::an_expired_session_key_is_rejected` |
| `20` | `ForbiddenForSession` | Session keys cannot authorize non-contract contexts or any `is_admin_fn` entry | `test::a_session_key_cannot_touch_any_admin_function` |
| `21` | `SpendLimitExceeded` | Session token transfers cannot exceed `SpendLimit.amount` within `period_secs` | `test::a_spend_limit_caps_session_transfers` |
| `22` | `BadArgs` | Rejects `ttl_secs == 0 \|\| ttl_secs > MAX_SESSION_TTL`, `timelock_secs < 3600`, negative spend limits, or non-contract `execute` entries | `test::an_overlong_session_lease_is_refused` |
| `23` | `NoGuardians` | `set_recovery`, `begin_recovery`, and `execute_recovery` require valid guardian configuration | `test::recovery_needs_no_owner_authorization_but_configuration_does` |
| `24` | `NotAGuardian` | `execute_recovery` and `remove_guardian` require registered guardian addresses | `test::a_non_guardian_cannot_be_counted_towards_recovery` |
| `25` | `DuplicateGuardian` | `execute_recovery` rejects duplicate guardian addresses in `signers` | `test::a_guardian_cannot_be_listed_twice_to_meet_quorum` |
| `26` | `QuorumNotMet` | `execute_recovery` requires at least `params.threshold` distinct guardian approvals | `test::recovery_refuses_a_short_quorum` |
| `27` | `TimelockNotElapsed` | `execute_recovery` requires `env.ledger().timestamp() >= pending.ready_at` | `test::guardian_quorum_recovers_the_wallet_after_the_timelock` |
| `28` | `NoRecoveryPending` | `execute_recovery` and `cancel_recovery` require an active `PendingRecovery` | `untested (direct negative test; positive lifecycle tested in test::the_owner_can_cancel_a_pending_recovery)` |
| `29` | `RecoveryInProgress` | `begin_recovery` refuses when a `PendingRecovery` is already active | `untested (direct negative test)` |
| `30` | `GuardianExists` | `add_guardian` rejects duplicate guardian registration | `untested (direct negative test)` |

### 3.3 `FactoryError` & Custody Invariants

| Component | Error / Guard | Invariant Enforced | Verifying Test |
| :--- | :--- | :--- | :--- |
| `obsyd_factory` | `FactoryError::NotInitialized (1)` | `require_admin` requires `DataKey::Admin` set by `__constructor` | `obsyd_factory::test::the_constructor_records_the_admin_and_no_build`, `test::a_live_factory_cannot_be_re_initialized` |
| `obsyd_factory` | `FactoryError::TooManyAccounts (2)` | `next_count` rejects `u32` counter overflow | `untested (requires u32::MAX accounts)` |
| `obsyd_factory` | `FactoryError::NoWasmHash (3)` | `preview_address` and `create_account` require a pinned `WasmHash` | `obsyd_factory::test::preview_needs_a_pinned_build` |
| `obsyd_factory` | `FactoryError::AccountExists (4)` | Rejects duplicate registration for the same `owner_public_key` | `obsyd_factory::test::registering_a_wallet_makes_it_resolvable` |
| `obsyd_factory` | `FactoryError::BadPublicKey (5)` | Rejects non-SEC1 uncompressed public keys (`len != 65 \|\| prefix != 0x04`) | `obsyd_factory::test::a_malformed_public_key_is_refused` |
| `obsyd_account` | Storage TTL Renewal | Passkey and session authorizations extend TTL of all consulted security keys to `seq + 40_000` | `obsyd_account::test::a_passkey_authorization_renews_the_state_it_read`, `test::a_session_authorization_renews_the_owner_state` |
| `frontend/wallet` | `refuse()` (`lib/custody.ts`) | Rejects any POST body field outside `{from, to, amount, address, xdr}` or matching `S[A-Z2-7]{55}` | `frontend/wallet/lib/__tests__/custody.test.ts`, `frontend/wallet/scripts/custody-live.mjs` |

---

## 4. Known Accepted Risks & Rationale

| Risk | Location | Rationale & Planned Mitigation |
| :--- | :--- | :--- |
| **Immediate Owner `upgrade` (No Timelock)** | `contracts/obsyd_account/src/lib.rs:678-682` (`SECURITY.md:143-145`) | `upgrade` requires owner passkey authorization (`is_admin_fn` blocks sessions), allowing rapid bug fixes during testnet/early rollout. Because a compromised passkey already has unrestricted spend authority, an immediate upgrade does not grant additional financial power beyond what the passkey already holds; optional timelocked or guardian-countersigned upgrades remain a future hardening item. |
| **Uncapped `execute` Targets for Owner Passkeys** | `contracts/obsyd_account/src/lib.rs:641-667` (`SECURITY.md:146-148`) | `execute` is restricted to the owner passkey (`is_admin_fn` blocks session leases) and signs the full `Vec<InvokerContractAuthEntry>` inside the WebAuthn challenge. Future dApp session delegation will require an explicit target contract allowlist. |
| **Unenforced WebAuthn Authenticator Signature Counter** | `contracts/obsyd_account/src/webauthn.rs:249-254` (`docs/PASSKEY_CONTRACT.md:79-81`) | `auth_data[33..37]` is parsed and emitted in the `passkey` event for off-chain auditing, but not enforced as strictly monotonic on-chain because synced/platform authenticators (iCloud Keychain, Google Password Manager, Windows Hello) frequently report `0` or clamp the counter. On-chain replay protection is instead enforced via `DataKey::PasskeyNonce`. |
| **Single-Step Factory `set_admin` with No Event** | `contracts/obsyd_factory/src/lib.rs:197-201` | `ObsydFactory::set_admin` immediately overwrites `DataKey::Admin` upon `require_admin`. A typo in the new address would permanently brick factory admin operations (`set_wasm_hash`, `register_account`), though existing deployed `obsyd_account` wallets remain unaffected. A two-step `propose_admin` / `accept_admin` pattern with event emission is recommended before mainnet. |
| **Pre-Contract Demo `localStorage` Signer in UI** | `frontend/wallet/lib/wallet.ts` (`SECURITY.md:138-142`) | Kept temporarily so the testnet send/swap UI works while passkey contract deployment is wired into the Next.js UI (#2). Mitigated by strict CSP `connect-src` and `refuse()` API guards, and clearly disclosed in the UI and `SECURITY.md`. |
