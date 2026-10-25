# Obsyd architecture

Obsyd is a **passkey smart-contract wallet** on Stellar Soroban. Two halves, one
boundary between them:

```
┌─ browser ──────────────────────┐      ┌─ node (Next.js API) ────────────┐
│  app/*  UI                     │      │  /api/balance  read balances     │
│  lib/passkey   WebAuthn        │      │  /api/fund     friendbot (test)  │
│  lib/wallet    device key      │      │  /api/send     BUILD unsigned    │
│  lib/soroban   build/sign/submit│ ─── │  /api/tx/submit RELAY signed xdr │
│                (isomorphic)    │ xdr │  /api/swap/quote read-only quote  │
└────────────────────────────────┘      │  /api/swap/faucet demo tokens    │
          │                             └───────────────┬──────────────────┘
          │  Soroban RPC / Horizon                      │
          ▼                                             ▼
┌─ chain ────────────────────────────────────────────────────────────────┐
│  obsyd_factory  ── deploy_v2 ──▶  obsyd_account (one per user)         │
│  Soroswap router/pools          Stellar Asset Contract balances        │
└────────────────────────────────────────────────────────────────────────┘
```

## The custody boundary

Nothing that looks like a key crosses the HTTP boundary. Concretely:

- `/api/send` returns **unsigned** XDR plus the network passphrase.
- The browser assembles a `Transaction` from that XDR, calls `tx.sign(signer)`
  with the key from `lib/wallet.ts`, and posts only the signed envelope to
  `/api/tx/submit`, which re-parses it against the configured passphrase, refuses
  unsigned envelopes, and relays it to Horizon.
- `/api/swap/quote` is read-only (simulation) and returns the *public* half of
  the demo pool (`publicPool()`); the swap itself is built, authorised and
  submitted from `lib/soroban.ts` in the browser.
- The only place a secret key is ever read is `lib/swap.ts` on the server, for
  the testnet faucet, from `scripts/pool.json` (gitignored). It signs treasury
  transfers and is never serialized into a response.
- That is enforced rather than merely observed: every route that reads a request
  body passes it through `refuse()` in `lib/custody.ts`, which accepts
  `from, to, amount, address, xdr` and rejects anything else — including any value
  shaped like an ed25519 seed — with a 400. A client that posts a key by mistake
  is told so, instead of being silently right while the key sits in a request log.

Module placement follows from that rule: `lib/soroban.ts` is deliberately free
of `node:fs`, `process.cwd()` and key material so a client component can import
it; anything that needs the filesystem stays in `lib/swap.ts`; `lib/custody.ts`
is the server's doorkeeper and is imported by routes only.

## Contracts (`contracts/`)

### `obsyd_account` — the wallet

A Soroban **custom account**: authorisation enters through `__check_auth`, which
accepts exactly two signature shapes.

1. **Passkey path** — the whole WebAuthn assertion is transported as the
   signature `Val`. `webauthn::verify` checks the SEC1 key prefix, the RP id
   hash, the UP/UV flags, `type == "webauthn.get"`, that the JSON
   `challenge` equals base64url of the host-provided `signature_payload`,
   optionally the `origin`, then `sha256(authData ‖ sha256(clientDataJSON))`
   and `secp256r1_verify` against the registered credential, and finally the
   per-credential replay nonce.
2. **Session path** — `Vec[key_id: BytesN<32>, sig: BytesN<64>, nonce: u64]`,
   an ed25519 lease minted by `elevate_session` after a passkey ceremony: a
   bounded expiry, its own nonce, per-token rolling spend caps, and a denylist
   (`is_admin_fn`) that stops a lease from ever mutating the wallet's own
   security. See `docs/PASSKEY_CONTRACT.md`.

State lives in `storage.rs` under one `DataKey` enum with explicit TTL
extension (persistent entries are extended to `sequence + 40_000`, threshold
`+ 20_000`, i.e. roughly the testnet maximum for one write). Because only writes
extend a lifetime and `__check_auth` is otherwise a read, both authorization paths
end by renewing the entries the decision consumed — signer set, policy, every
spend cap, recovery configuration — so an active wallet cannot age into a state
where it no longer recognizes its own keys.

Admin operations: passkey set management (`add_passkey`, `remove_passkey`,
`rotate_passkey`), `set_policy`, session mint/revoke, `set_spend_limit`,
guardians + `set_recovery` / `begin_recovery` / `execute_recovery` /
`cancel_recovery`, `execute` (batched `authorize_as_current_contract`, used for
`approve` + `swap` in one transaction), and `upgrade`.

### `obsyd_factory` — counterfactual deployment

`create_account` deploys an `obsyd_account` with
`deployer().with_current_contract(sha256(public_key)).deploy_v2(...)`, so
`preview_address(public_key)` can return the *same* address before it exists.
The user can be shown a deposit address during onboarding, and it cannot be
changed by anyone else: the salt is derived from their credential.

The factory's admin is a `__constructor` argument of the factory's own deploy
transaction — the host reserves `__`-prefixed functions, so there is no public
`initialize` for someone else to call first, and no later transaction can move
the factory to a new admin. `create_account` and `register_account` both write
the credential→address entry, the enumeration index and the counter, so
`address_of`, `accounts` and `count` can never disagree; every factory write
extends its TTL, and deploying renews the admin and the pinned build.

## Data flow: a swap

1. UI → `/api/swap/quote?from&to&amount&address` → `quoteUnits` simulates
   `token_0`/`token_1`/`get_reserves` on the pair and `get_amount_out` on the
   router, and applies slippage in basis points.
2. UI holds `{quote, pool}`. On confirm, `swapExactTokens(signer, pool, …)`
   builds `invoke_contract(swap_exact_tokens_for_tokens)`, simulates, signs each
   `SorobanAuthorizationEntry` locally (`authorizeInvocation`), assembles the
   fee-bump-free transaction, sends it over RPC and polls to `SUCCESS`.
3. Balances are re-read through `tokenBalance` (a simulation), not assumed.

## Frontend

Next.js 14 App Router, TypeScript, no UI framework — the design system is
`app/globals.css` (`.o-*` classes: cards, insets, buttons, skeletons) with a
blue-black neumorphic palette. Routes: onboarding (`app/page.tsx`), `dashboard`,
`send`, `receive`, `swap`, `recover`, `contacts`, `settings/*`. Every network
call goes through `lib/`, never `fetch` inline in a component except for the API
routes of this same app.

## Known gaps

The demo wallet's signer is still a device-local ed25519 key; the passkey path
in `obsyd_account` is implemented and unit-tested but not yet wired into the UI,
which needs the contract deployed and a client that assembles a WebAuthn
assertion into a `SorobanAuthorizationEntry`. Balances are classic-channel only
(SAC balances are not merged into the dashboard). `scripts/pool.json` binds the
swap demo to a provisioned testnet pair. `SECURITY.md` lists these with the
threat model.
