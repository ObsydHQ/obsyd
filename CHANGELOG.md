# Changelog

All notable changes to Obsyd are documented here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The passkey wallet now has the contracts its name promised, and no secret key
travels over HTTP any more.

### Changed

- **Issues are maintainer-filed.** The bug-report template is gone and blank
  issues are disabled; the new-issue chooser only links to private
  vulnerability reporting and to the contributing guide. `issue-gate.yml`
  closes, with an explanation, any issue opened by someone who is not an
  owner, member or collaborator. Contributors raise findings in their PR or on
  the issue they are working on.

### Fixed

- **WebAuthn flag bits in `obsyd_account`** — UV was read from bit 1 (`0x02`,
  reserved, never set) instead of bit 2 (`0x04`), and BE/BS from `0x04`/`0x08`
  instead of `0x08`/`0x10`. With the default policy no real passkey could
  authorise anything. The unit tests built fixtures from the same wrong values;
  they now spell the bits out independently and cover the reserved bit and BS.
  Found by the first live testnet run.

### Added

- **`scripts/passkey-live.mjs`** — end-to-end testnet proof: deploys the
  contracts, creates a passkey in a real Chromium browser, deploys a wallet for
  it and sends XLM out of it authorised by the passkey alone, then checks that a
  replayed and a re-pointed assertion are refused by the wallet.
- **`contracts/obsyd_account`** — a Soroban custom account whose `__check_auth`
  verifies real WebAuthn assertions: `rp_id_hash` binding, UP/UV/backup flag
  policy, `webauthn.get` ceremony type, the host `signature_payload` as the
  challenge, and `secp256r1_verify` over
  `sha256(authData ‖ sha256(clientDataJSON))`, with a per-credential replay
  nonce. This is the contract the README has always described.
- **Session keys** inside the same account: `elevate_session` mints a
  time-bounded (≤ 7 days) ed25519 lease after a passkey ceremony; leases are
  blocked from every administrative function by an explicit denylist, carry
  their own nonce, and are charged against per-token rolling spend caps.
- **Guardian recovery** behind a timelock (≥ 1 hour): `begin_recovery` is
  permissionless so a locked-out owner can start it, `execute_recovery` requires
  a quorum of registered guardians to each `require_auth`, and completing it
  revokes every session. `cancel_recovery` lets the owner abort.
- **`execute`** — batched `InvokerContractAuthEntry` execution
  (`authorize_as_current_contract`), so `approve` + `swap` on Soroswap is one
  atomic transaction signed once by the passkey.
- **`upgrade`** — owner-signed WASM replacement that keeps storage and address.
- **`contracts/obsyd_factory`** — counterfactual deployment
  (`deploy_v2`, `salt = sha256(public_key)`), so `preview_address` can hand out a
  wallet address before the wallet exists, plus a credential→address registry.
- **Contract tests** (`contracts/*/src/test.rs`) — 50 unit tests (40 account, 10
  factory) that build genuine P-256 and ed25519 signatures with `p256` /
  `ed25519-dalek` fixtures and
  drive `__check_auth` through the SDK's auth checks, including the negative
  paths (wrong RP id, replayed assertion, `webauthn.create` ceremony, expired
  lease, admin call through a session, over-cap spend, quorum not met, timelock
  not elapsed) and the durability paths, where an aged wallet authorizes once and
  every entry the decision read is asserted — against the ledger's own TTL
  bookkeeping — to have been renewed.
- **Client-side signing** (`frontend/wallet/lib/wallet.ts` + `lib/soroban.ts`) —
  the wallet's key is generated in the browser, and transactions are built
  unsigned by the API, signed on the device, and relayed.
- `POST /api/tx/submit` — relays a signed envelope; refuses unsigned ones.
- **The custody boundary is a module, not a convention**
  (`frontend/wallet/lib/custody.ts`) — `refuse()` is the one guard every route that
  reads a request body runs first: it allows `from, to, amount, address, xdr` and
  nothing else, and rejects any value shaped like an ed25519 seed.
- `lib/__tests__/custody.test.ts` — 10 tests that read the app's own source and
  assert the API surface is exactly the documented table of endpoints and body
  fields, that no request the wallet builds can carry a key, that no route signs
  with a caller-supplied one, and that each route imports the guard. Each scan is
  run against a planted leak first, because a scan that reports nothing is only
  worth something once it has reported something.
- `scripts/custody-live.mjs` — the same invariant over the wire: funds two
  throwaway testnet accounts, builds a payment through `/api/send`, signs it
  locally, relays it, and then plants a real secret in three request bodies to
  confirm each is refused. 15 checks, all green against testnet.
- **Response headers on every route** (`frontend/wallet/next.config.js`) —
  `connect-src` lists only the wallet's own API and the Horizon / Soroban RPC /
  friendbot origins from the config, so a script that had already read the device
  key would have nowhere to send it; plus `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri`/`form-action 'self'`, `nosniff`,
  `no-referrer`, a closed `Permissions-Policy`, HSTS and COOP. Development serves
  the policy Report-Only and production enforces it.
- `frontend/wallet/.env.example` documenting every network knob.
- `vitest` suites for the amount/quote math, COSE public-key parsing, base64url
  and address validation; `npm run test`, `npm run typecheck`, `npm run lint`.
- GitHub Actions CI: contract wasm build + `cargo test`, typecheck, lint,
  vitest, and a secret scan. A `.githooks/pre-commit` secret scan for locals.
- `ARCHITECTURE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `contracts/README.md`,
  `docs/PASSKEY_CONTRACT.md`.

### Changed

- **Every route that reads a body now refuses one that carries a key.**
  `/api/fund` and `/api/swap/faucet` picked `address` out of the body and silently
  ignored anything else, so a client that posted a secret got a 200 while the key
  sat in a request log. They answer 400 now, the same as `/api/send` and
  `/api/tx/submit`, and all four share the one guard rather than four copies of it.
- **`/api/send` no longer accepts or uses a secret.** It builds and returns
  unsigned XDR plus the network passphrase; the browser signs and
  `/api/tx/submit` relays. It is therefore no longer testnet-only — the
  server-side build path has no key to protect.
- **`/api/swap` is gone.** Quote (`/api/swap/quote`) is read-only and returns the
  public half of the pool config; `swapExactTokens` runs in the browser.
- **`/api/demo` is gone.** The demo wallet's keypair is generated in the browser
  and funded through `/api/fund`, so no endpoint returns a private key any more.
- `lib/swap.ts` is a thin server-only module (pool config + faucet) over the new
  isomorphic `lib/soroban.ts`, which contains no `node:fs`, no `process.cwd()`
  and no key material and is safe to import from a client component.
- Swap and send screens show the custody boundary in their own copy: "built
  unsigned by the API, signed on this device".
- `Cargo.lock` pins `ed25519-dalek` to 2.2.0; `soroban-env-host`'s unbounded
  `>= 2.0.0` requirement otherwise resolves 3.0.0, whose `rand_core` change
  breaks the SDK's testutils build.
- The factory's public `initialize` is gone; its admin is now a `__constructor`
  argument of the factory's own deploy transaction. `initialize` was callable by
  anyone until the first call landed, which made whoever reached it first the
  factory's admin — the same front-running window the wallet's constructor
  closes. Pinning the approved build stayed an admin-gated `set_wasm_hash` call,
  so `AlreadyInitialized` no longer has a meaning and is removed.
- The factory checks its registry counter can still be incremented *before*
  deploying, so there is no path that leaves a wallet live but absent from
  `address_of`; the error it returns for that is `TooManyAccounts` (the unused
  `Unauthorized` variant is gone — admin gating is `require_auth`, which fails at
  the host, not with a contract error).

### Fixed

- **The settings rows parsed their own labels as HTML.** They passed them through
  `dangerouslySetInnerHTML`; the labels were literals, so nothing was reachable,
  but a page that holds a device key should not contain an HTML sink at all, and
  one that takes a copy prop should not turn a future `<` into a payload.
- **A wallet would have expired into an unusable state.** Soroban only extends a
  storage lifetime on *write*, and `__check_auth` is a read-only decision apart
  from the nonce it advances — so the signer set, the RP policy, every spend cap
  and the recovery configuration lapsed roughly 40,000 ledgers after deployment,
  with no call able to restore them (the wallet would stop recognising its own
  passkeys, and a lapsed cap reads back as *no cap*). Both auth paths now refresh
  the state the decision consumed; the factory renews its admin and pinned build
  as it deploys.
- **The factory registry could disagree with itself.** `register_account` wrote
  the credential→address entry but not the enumeration behind it, so a wallet
  registered out of band was invisible to `accounts()` and `count()`. Every
  registration now writes all three entries.
- **The session denylist was missing two entries.** `execute` and
  `begin_recovery` were not in `is_admin_fn`, and `execute` is the worst possible
  omission: it re-authorizes a whole call tree *as the wallet itself*, so a lease
  that could reach it could have added a passkey through that inner tree and
  bypassed the denylist entirely. Recovery could also have been started without a
  passkey ceremony.
- `remove_passkey` could empty the signer set and lock the wallet out; it now
  refuses with `LastPasskey`.
- A session lease with a malformed or negative `transfer` amount was treated as
  "nothing to charge"; unparseable amounts now refuse the authorisation.
- `rotate_passkey` performed two `require_auth` rounds through a nested public
  call, consuming a second replay counter; the shared logic is now a private
  helper and a rotation needs one ceremony.
- Demo pool config (`scripts/pool.json`, which holds a testnet treasury secret)
  is gitignored, and the new secret scan blocks committing it.

## [0.1.0] — 2026-10

First public shape of the repo: Next.js 14 wallet UI with the blue-black
neumorphic design system, a device passkey (WebAuthn) identity layer that
derives a deterministic smart-wallet address, live testnet balances and activity
through Horizon, XLM send, a demo faucet, and a real Soroswap testnet swap
(path `OBA/OBB`) quoted off pool reserves with slippage protection — signed
server-side from a client-supplied testnet secret.

[unreleased]: https://github.com/ObsydHQ/obsyd/compare/main...HEAD
[0.1.0]: https://github.com/ObsydHQ/obsyd/releases/tag/v0.1.0
