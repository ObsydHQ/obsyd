# Security policy

Obsyd holds user keys and runs contract logic that has not been audited, against
testnet and eventually mainnet funds. Treat security work as a first-class feature.

## Reporting a vulnerability

Report through GitHub's **[private vulnerability reporting](https://github.com/ObsydHQ/obsyd/security/advisories/new)**
(open an advisory rather than an issue). Do not open a public issue. We aim to
acknowledge within 48 hours and ship a fix or mitigation within 7 days for
anything that can move funds.

## The invariant: keys do not cross the network

The API is untrusted infrastructure. It builds and relays transactions; it does
not sign them.

| Endpoint | Input | Output | Can it see a key? |
| --- | --- | --- | --- |
| `POST /api/send` | from, to, amount | **unsigned** XDR | no — `refuse()` rejects any other field with 400 |
| `POST /api/tx/submit` | signed XDR | tx hash / Horizon result codes | no — relays only, refuses unsigned envelopes |
| `GET /api/swap/quote` | from, to, amount, address | quote + public pool | no — read-only simulation |
| `POST /api/swap/faucet` | address | faucet receipt | holds the *demo treasury* key server-side; never returns it |
| `POST /api/fund` | address | friendbot receipt | no |
| `GET /api/balance` | address | balances + activity | no |

That table is enforced, not documented hope. Every route that reads a request
body calls `refuse()` from `lib/custody.ts` first, which rejects any field
outside `{from, to, amount, address, xdr}` and any value shaped like an ed25519
secret seed — so a wallet that posts a key by mistake gets a 400 rather than a
silent success, and the key never reaches a handler. `lib/__tests__/custody.test.ts`
asserts the table, the guard import on every route, and that no route can sign
with a caller-supplied key; each scan runs against a planted leak first, because
a scan that reports nothing is only trustworthy once it has reported something.

`lib/soroban.ts` (browser-safe, no fs, no key material) is where signing happens;
`lib/wallet.ts` is the only reader/writer of the device key. `lib/swap.ts` is
server-only and is the single module allowed to touch `scripts/pool.json`.

A regression that puts a secret in a request body or a response is a bug in the
table above, not a design decision — CI greps for it (`.github/workflows/ci.yml`,
`secret-scan` job), `npm test` checks the source (`lib/__tests__/custody.test.ts`),
and `node scripts/custody-live.mjs` checks the running server by planting a
throwaway key in three bodies and failing if any of them is accepted.

## Browser-side defences

The custody boundary protects the API from the key. The browser's own response
headers protect the key from the browser's threats — set for every route in
`frontend/wallet/next.config.js`:

- **`connect-src` names the only servers this page can talk to**: its own API plus
  the Horizon, Soroban RPC and friendbot origins in the config. A script that got
  as far as reading `localStorage` still cannot post the key to a server of its
  attacker's choosing; it has no route to one.
- `script-src`/`default-src 'self'` block remote script; `object-src 'none'`,
  `frame-ancestors 'none'` + `X-Frame-Options: DENY` block plugin content and
  clickjacking of the send form; `base-uri`/`form-action 'self'` block the two
  classic CSP-bypass tricks that a `<base>` tag or a redirected form would allow.
- `Referrer-Policy: no-referrer` keeps an account address out of third-party
  logs; `Permissions-Policy` closes camera, microphone, geolocation, payment and
  USB — WebAuthn, which the wallet does need, is not gated by any of them.
- In development the policy is served **Report-Only**, so a mistake surfaces in
  the browser console rather than silently breaking the wallet mid-edit; the
  production build enforces it.

CSP is a mitigation, not a cure: `script-src 'unsafe-inline'` is still required
for Next to hydrate, so an injected inline script can run — it just cannot reach
an origin we did not already trust. The real answer to that is the passkey
contract, which removes the device secret entirely.

## Contract security model (`contracts/obsyd_account`)



Authorisation is `__check_auth`, and everything else is derived from it:

- **Replay resistance.** The WebAuthn `challenge` must equal base64url of the
  host-supplied `signature_payload`, which commits to this exact invocation; a
  captured assertion cannot be reused on another transaction. On top of that,
  every credential and every session carries its own counter, checked and
  advanced inside the same authorized call.
- **Fail-closed signature checks.** `secp256r1_verify` / `ed25519_verify` trap on
  a bad signature, so an invalid assertion aborts the transaction rather than
  returning a value a caller could ignore.
- **Policy binding.** `rp_id_hash` is compared byte-for-byte; UP/UV flags are
  enforced against the stored policy; backup-eligible/passkey-credential flags
  are rejected unless the owner opted in; `clientDataJSON.type` must be
  `webauthn.get`, so a registration ceremony can never authorise a spend.
- **Session leases can't escalate.** A session key may move tokens but is
  blocked by `is_admin_fn` from `add_passkey`, `rotate_passkey`, `remove_passkey`,
  `set_policy`, `set_recovery`, `begin_recovery`, `execute_recovery`,
  `cancel_recovery`, `elevate_session`, `revoke_*`, `set_spend_limit`,
  `clear_spend_limit`, guardian management, `upgrade` and `execute`. Leases expire
  (`MAX_SESSION_TTL` = 7 days), have their own nonce, and are capped per token by
  a rolling `SpendLimit`; a rejected charge leaves the nonce untouched so a
  failed attempt is not a replay vector.
- **Timelocked recovery.** `begin_recovery` is permissionless (that is the point:
  a locked-out user needs it) but only queues. `execute_recovery` requires the
  timelock (≥ 1 hour) to have elapsed, distinct *registered* guardians, a real
  `require_auth` from each, and the configured quorum; it revokes every session
  and every outstanding lease when it succeeds.
- **Batch execution is signed as a whole.** `execute` runs a
  `Vec<InvokerContractAuthEntry>` whose tree is part of the authorized arguments,
  so a passkey prompt over `execute` cannot be talked into running something
  else. Non-contract entries (create/deploy) are rejected, not skipped.
- **Last-key lockout guard.** `remove_passkey` refuses to remove the final
  credential; `rotate_passkey` atomically swaps one credential for another and
  wipes all leases.
- **Initialization happens once, at deploy.** The owner credential and RP policy
  are set by `__constructor`, which the factory calls inside `deploy_v2` — there
  is no separate `initialize` transaction to front-run, and the host reserves
  `__`-prefixed functions against direct calls, so nobody can re-run it later to
  hand a live wallet a new owner. A test asserts both halves of that
  (`a_live_wallet_cannot_be_re_initialized_by_anyone_else`). The factory is
  initialized the same way: its admin is a constructor argument of the deploy
  transaction, so there is no first-write race to own it either.
- **The wallet renews the state it authorizes from.** Soroban storage expires,
  and only writes push a lifetime forward — while `__check_auth` is a read-only
  decision apart from the nonce it advances. Left at that, a wallet would stop
  recognising its own passkeys about 40,000 ledgers after deployment, and an
  expired spend cap reads back as *no cap*. Both auth paths therefore finish by
  extending the signer set, the policy, every cap and the recovery
  configuration (`refresh_passkey_auth` / `refresh_session_auth`), asserted
  directly against the ledger's TTL bookkeeping in
  `a_passkey_authorization_renews_the_state_it_read` and
  `a_session_authorization_renews_the_owner_state`.

## Testnet-only guards

`/api/swap/faucet` and `/api/fund` are unauthenticated by design and mint test
assets. They are hard-gated on `config.network === "testnet"`; leaving that gate
off in production would let anyone drain the demo treasury (test tokens only) —
keep the gate.

## Open items

- The demo wallet's signer is an ed25519 key in `localStorage`. That is the
  pre-contract custody model, kept only so the swap/send demo works today; the
  passkey contract is the replacement and is tracked in
  [#2](https://github.com/ObsydHQ/obsyd/issues/2). Until it is deployed, do not
  fund a demo wallet with anything you would mind losing.
- `upgrade` is owner-signed and does not enforce a delay — a compromised passkey
  could swap the logic immediately. A timelocked (or guardian-countersigned)
  upgrade path is the natural next hardening step.
- No reentrancy guard on `execute` beyond Soroban's own auth stack; the router
  calls it makes are to known Soroswap contracts, but a future generic dApp
  session should pin the target set.
- WebAuthn assertion verification assumes a `uv`-capable authenticator; platform
  passkeys with `uv=0` are rejected by policy, which is correct but means a
  roaming key without user verification cannot be added.
