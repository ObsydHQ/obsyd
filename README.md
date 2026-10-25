# Obsyd

> Your passkey is your wallet. No seed phrase. No password. Just your biometric —
> securing a smart-contract wallet on **Stellar Soroban**.

**Obsyd** is an open-source (MIT) passkey smart-contract wallet for the Stellar
[Soroban](https://stellar.org/soroban) network, with a **blue-black obsidian +
electric-cobalt** neumorphic UI and a focused core-wallet scope.

The heart of it is on-chain: `contracts/obsyd_account` is a Soroban **custom
account** whose `__check_auth` verifies a real WebAuthn assertion — the
host's `signature_payload` is the challenge, the credential is a P-256 key
checked with `secp256r1_verify`, and every credential carries its own replay
nonce. `contracts/obsyd_factory` deploys one per credential
counterfactually, so a wallet address is knowable before the wallet exists.
Alongside it: session keys with per-token spend caps, timelocked guardian
recovery, and atomic `approve` + `swap` batching.

What is finished and what is not, stated plainly: the contracts are written and
tested (48 unit tests over real P-256 / ed25519 signatures) but **not yet
deployed**, and the testnet account the app funds today is still a device
keypair, not one of those contracts. The custody boundary below is real either
way, and every screen that is still mock says so on screen.

---

## What's inside

- **Contracts (Rust / Soroban)** — passkey account + factory, 48 unit tests
  built on genuine P-256 / ed25519 signatures. See
  [`docs/PASSKEY_CONTRACT.md`](./docs/PASSKEY_CONTRACT.md).
- **Passkey registration** — Settings → Passkeys creates a real WebAuthn
  credential (Face ID / fingerprint / Windows Hello) and derives the wallet's
  identity from its P-256 public key (`sha256` → `obsyd_…`). Deploying that
  identity on-chain through `obsyd_factory` — so the identity *is* the account,
  with an address knowable before it exists — is the next phase and is labelled
  as such in the UI; today the account that holds testnet funds is a classic
  ed25519 key the contract replaces.
- **Dashboard** — live testnet balances and activity from Horizon.
- **Send** — passkey step-up, transaction built **unsigned** by the API, signed on
  the device, relayed to the network.
- **Swap** — real **Soroswap** AMM on testnet: quote off live pool reserves,
  slippage-protected `swap_exact_tokens_for_tokens`, signed and submitted from the
  browser.
- **Recovery** — guardian-based and timelocked **in the contract**
  (`begin_recovery` → quorum of `require_auth`ed guardians → session revocation).
  The restore screen is still a mock and does not reach the chain yet.
- **Receive / Contacts / Settings** — the receiving address and the
  passkey-derived identity, copy-to-clipboard, saved recipients, network and
  passkey management. The QR is a placeholder box, not a rendered code — an
  address you cannot scan is a small lie, so it is marked as unfinished here
  rather than claimed.

> Not in this build: the AI agent, shielded sends, vault, multisig, NFTs, pool
> management, bills, dApp/WalletConnect bridges.

## Custody model, in one table

No private key crosses the HTTP boundary. Ever.

| Endpoint | Does | Sees a key? |
| --- | --- | --- |
| `POST /api/send` | builds **unsigned** XDR | no |
| `POST /api/tx/submit` | relays a **signed** envelope | no (refuses unsigned) |
| `GET /api/swap/quote` | read-only simulation + public pool | no |
| `POST /api/swap/faucet` | testnet demo tokens (testnet-gated) | server-side treasury only |
| `POST /api/fund` | friendbot (testnet-gated) | no |
| `GET /api/balance` | balances + activity | no |

Every one of them takes only `from, to, amount, address, xdr` and nothing else:
`lib/custody.ts` answers 400 to any other field, and `npm test` checks that each
route actually calls the guard.

Full policy and threat model: [`SECURITY.md`](./SECURITY.md). Structure and data
flow: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Monorepo layout

```
obsyd/
├─ contracts/            # Soroban contracts (Rust)
│  ├─ obsyd_account/     #   passkey custom account: __check_auth, sessions,
│  │                     #   spend caps, guardian recovery, batched execute
│  └─ obsyd_factory/     #   counterfactual deployment + credential registry
├─ frontend/
│  └─ wallet/            # Next.js 14 App Router wallet UI (Obsyd design system)
│     ├─ app/            #   routes + API (build/relay, quote, faucet, balances)
│     ├─ lib/            #   passkey identity, device custody, Soroban layer
│     └─ scripts/        #   Soroswap demo-pool provisioning + probes
├─ docs/                 # PASSKEY_CONTRACT.md — the assertion wire format
└─ .reference/           # gitignored third-party study checkout — NOT shipped code
```

## Getting started

```bash
npm install                      # workspaces from the repo root
cp frontend/wallet/.env.example frontend/wallet/.env.local
npm run dev                      # http://localhost:3000
```

```bash
npm run typecheck                # tsc --noEmit
npm test                         # vitest: math, COSE/base64url, addresses, custody
npm run lint                     # eslint
```

## Contracts

```bash
cd contracts
rustup target add wasm32v1-none
cargo build --workspace --release --target wasm32v1-none   # the deployable wasm
cargo test --workspace                                     # the unit tests
```

`cargo build` and `cargo test` are separate concerns here: the wasm target is the
artifact, the host target runs the tests. On Windows host linking of a
`cdylib`+`rlib` crate is unreliable, so `cargo check --workspace --tests` is the
local gate and CI runs the tests — see [`contracts/README.md`](./contracts/README.md)
for that and for the `ed25519-dalek` pin the SDK's testutils require.

To put a wallet on testnet: build the two WASMs, `soroban contract deploy` the
account and the factory — the factory takes its admin as a constructor argument,
so there is no `initialize` call to win — then `set_wasm_hash(accountBuild)`,
`preview_address(credential)` → `create_account(...)`. The walkthrough, with the
exact `soroban contract invoke` calls, is in
[`contracts/README.md`](./contracts/README.md).

## Swap demo (Soroswap on testnet)

The swap screen talks to the live **Soroswap** router/factory on Stellar testnet.
The testnet factory ships with no liquidity, so the demo provisions its own pool
of two admin-controlled test tokens (OBA / OBB):

```bash
cd frontend/wallet
node scripts/provision-pool.mjs   # deploys tokens, creates a pair, adds 100k/100k liquidity
```

This writes `scripts/pool.json` (gitignored — it contains a throwaway testnet
treasury secret key, which stays on the server and signs only faucet transfers).
UI flow: load a demo wallet → **Get test tokens** (treasury faucet) → enter an
amount (live quote from pool reserves) → **Swap on Soroswap**.

The quote is `router.get_amount_out(amount_in, reserve_in, reserve_out)`; the
execution is `router.swap_exact_tokens_for_tokens(amount_in, amount_out_min, path,
to, deadline)`, assembled and signed in the browser with
`@stellar/stellar-sdk` v17 (`rpc` namespace, `authorizeInvocation`,
`assembleTransaction`).

## Roadmap

The open issues are the roadmap: deploying the account contract and making the
passkey the actual signer, SAC balances in the dashboard, an on-chain session
management screen, and hardware-key assertion support. See
[`SECURITY.md`](./SECURITY.md#open-items) for what is honestly not finished yet.

## Contributing

Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev environment, the exact
commands CI runs, and the review notes for contract code. Good first steps:
a contract test for a path you think is under-specified, or a UI screen for the
session/limit surface the contract already exposes.

## License

Obsyd is released under the **MIT License**. See [LICENSE](./LICENSE).

Copyright (c) 2026 Obsyd contributors.
