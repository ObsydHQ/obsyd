# Obsyd

> Your passkey is your wallet. No seed phrase. No password. Just your biometric —
> securing a smart-contract wallet on Stellar Soroban.

**Obsyd** is an open-source, passkey-powered smart-contract wallet for the Stellar
[Soroban](https://stellar.org/soroban) network, with a **blue-black obsidian +
electric-cobalt** neumorphic design and a focused **core-wallet** scope.

---

## What's inside (core wallet scope)

- **Onboarding** — create a wallet with a device passkey (Face ID / fingerprint / Windows Hello); deterministic smart-wallet address derived from your passkey public key.
- **Recovery** — restore / guardian-based recovery of an existing wallet.
- **Dashboard** — balances and assets.
- **Send** — sign and submit payments with a passkey step-up.
- **Receive** — share address / QR.
- **Swap** — live token swaps against a real **Soroswap** AMM on testnet: on-chain quote from pool reserves, slippage-protected `swap_exact_tokens_for_tokens`, signed and submitted end-to-end.
- **Contacts** — saved recipients.
- **Settings** — network, profile, and passkey (signer) management.

> Not included in this build: the AI agent, privacy/shielded sends, vault, multisig,
> NFTs, pools, bills, and dApp/WalletConnect integrations. These may be added as later phases.

## Monorepo layout

```
obsyd/
├─ frontend/
│  └─ wallet/        # Next.js 14 App Router wallet UI (Obsyd design system)
│     ├─ app/        # routes + API (send, swap quote/execute, faucet, balances)
│     ├─ lib/        # data + Soroban swap layer
│     └─ scripts/    # Soroswap demo-pool provisioning + probes
├─ sdk/              # (planned) Passkey (WebAuthn) + Soroban client
├─ contracts/        # (planned) Soroban contracts (factory + smart wallet)
├─ services/         # (planned) Node/DB helper services
└─ .reference/       # gitignored third-party reference checkout — NOT part of the shipped code
```

> The shipped code today is the `frontend/wallet` app (UI + API routes + swap
> scripts). `sdk/`, `contracts/`, and `services/` are the planned next phases and
> are not yet present in this tree.

## Getting started

```bash
npm install            # install all workspaces (root)
npm run dev            # start the wallet frontend on http://localhost:3000
```

Contract wasm builds target the **windows-gnu** Rust toolchain on Windows and are
run separately (see `contracts/`), not as part of the web dev server.

## Swap demo (Soroswap on testnet)

The swap feature talks to the live **Soroswap** router/factory on Stellar testnet.
Because the testnet factory ships with no liquidity, the demo provisions its own
pool of two admin-controlled test tokens (OBA / OBB):

```bash
cd frontend/wallet
node scripts/provision-pool.mjs   # deploys tokens, creates a pair, adds 100k/100k liquidity
```

This writes `scripts/pool.json` (gitignored — it contains a throwaway testnet
treasury secret key). With a pool present, the UI flow is: load a demo wallet →
**Get test tokens** (treasury faucet) → enter an amount (live quote from pool
reserves) → **Swap on Soroswap** (signed `swap_exact_tokens_for_tokens`).

Quote uses `router.get_amount_out(amount_in, reserve_in, reserve_out)`; execution
uses `router.swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)`.
All signing is via `@stellar/stellar-sdk` v17 (`rpc` namespace, `authorizeInvocation`,
`assembleTransaction`).

## License

Obsyd is released under the **MIT License**. See [LICENSE](./LICENSE).

Copyright (c) 2026 Obsyd contributors.
