# Contributing to Obsyd

Thanks for being here. Obsyd is a passkey smart-contract wallet on Stellar
Soroban: the interesting parts are the contract's authorisation logic and the
custody boundary between the browser and the API, so read
[`ARCHITECTURE.md`](./ARCHITECTURE.md) and
[`docs/PASSKEY_CONTRACT.md`](./docs/PASSKEY_CONTRACT.md) first.

## Dev environment

```bash
git clone https://github.com/ObsydHQ/obsyd && cd obsyd
npm install                      # workspaces at the repo root

# contracts (optional, for contract work)
rustup target add wasm32v1-none
cd contracts && cargo build --workspace --release --target wasm32v1-none

# wallet app
npm run dev                      # http://localhost:3000
```

Requirements: Node 20+, Rust stable with the `wasm32v1-none` target. On Windows,
the `x86_64-pc-windows-gnu` toolchain works; contract *tests* are run in CI
because host linking of a `cdylib`+`rlib` crate is unreliable there (see
`contracts/README.md`).

A real testnet demo wallet needs a Soroswap pair. `frontend/wallet/scripts/
provision-pool.mjs` deploys two test tokens, opens a pair and adds liquidity, then
writes `scripts/pool.json`. That file contains a **throwaway testnet treasury
secret** and is gitignored — never commit it, never paste it into an issue.

## Test before you open a PR

| Command | Checks |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over the wallet app |
| `npm test` | vitest: amount math, quote math, passkey COSE/base64url parsing, address validation, and the custody boundary |
| `npm run lint` | ESLint (Next + react-hooks rules) |
| `cd contracts && cargo test --workspace` | contract unit tests with real P-256/ed25519 signatures |
| `cd contracts && cargo check --workspace --release --target wasm32v1-none` | the contract compiles to wasm |
| `node frontend/wallet/scripts/probe-swap.mjs` | the swap demo still quotes and executes against a live pool |
| `node frontend/wallet/scripts/custody-live.mjs` | the custody boundary holds over the wire, against a running server |

CI runs every row above except the last two, which need live testnet
credentials and a running dev server. A PR that breaks one of them and says "CI will catch it" will
usually be asked to fix it first — slow builds on this project are shared
infrastructure.

## What a good PR looks like

- One concern per PR. A contract change and a UI change are two PRs unless the UI
  change exists only to exercise the contract change.
- The description says **what user-visible behaviour changes**, not just which
  files were touched, and links the issue it closes.
- Contract PRs include a failing-before/passing-after test. If you changed
  `__check_auth`, add a test that attempts to bypass it — a negative test is the
  review.
- Any new error path gets its own typed error variant, and a test that triggers
  it.
- UI PRs follow the design system in `app/globals.css` (`.o-card`, `.o-btn`,
  `.o-stack`, `.o-mono`, `--accent` blue on near-black). No new colours without
  adding a token there first.
- Docs move with the code: an endpoint table in `SECURITY.md`, a module note in
  `ARCHITECTURE.md`, a line in `CHANGELOG.md`.

## Scope

The roadmap is the issue tracker. Features that are explicitly **out** of scope
for now: an AI agent, shielded/private sends, vaults, multisig, NFTs, pool
management, bills, dApp/WalletConnect bridges. Work on an existing issue; a
large unrequested PR is usually closed rather than reviewed.

## Issues are maintainer-filed

Every task, including each Drips Wave task, is already an issue, written and
labelled by a maintainer. Contributors don't open issues: the new-issue form is
disabled, and an issue opened by anyone other than a maintainer is closed
automatically (`.github/workflows/issue-gate.yml`).

- **To contribute:** pick an open issue, comment that you're taking it, and
  open one PR that says `Closes #<number>`.
- **Found a bug or have an idea along the way?** Put it in your PR description,
  or comment on the issue you're working on. A maintainer will file it if it's
  worth doing. Don't widen your PR to fix it unless asked.
- **Security problem?** Report it privately through
  [GitHub's advisory form](https://github.com/ObsydHQ/obsyd/security/advisories/new),
  never in a PR, comment or issue. See [`SECURITY.md`](./SECURITY.md).

## Review notes for contract code

- Never trust `Vec` lengths or `Bytes` indices without a bounds check; use
  `get_unchecked` only after an explicit length check.
- Any signature check must fail closed: `secp256r1_verify`/`ed25519_verify` trap,
  so verify *before* you advance a nonce or charge a limit.
- Every state write extends its TTL — and so must every read that gates an
  authorization. `__check_auth` writes only a nonce, so an entry it consulted has
  to be renewed in `refresh_passkey_auth` / `refresh_session_auth` or the wallet
  slowly forgets the very state that lets it say yes.
- `__check_auth` is the security boundary: the passkey path has no spend caps and
  the session path has all of them — keep it that way deliberately.
- Do not add a public function that calls `require_auth` on another contract's
  behalf without thinking about `execute` re-entrancy.

## Review notes for the custody boundary

- The API builds and relays; the device signs. A new endpoint that reads a request
  body must call `refuse()` from `lib/custody.ts` before it acts on anything, and
  add its field to `ALLOWED_FIELDS` there *and* to the body table in
  `lib/__tests__/custody.test.ts`. Both edits, or the test is lying.
- Never widen the boundary to make a client work. If a legitimate caller needs a
  new field, that is a design change: say so in the PR and expect it to be
  argued about.
- When you add a route, extend the scans. `custody.test.ts` reads the app's own
  source, so a request built somewhere it does not look at is a request nobody
  has checked.
- `scripts/custody-live.mjs` is the same invariant over the wire. Run it after any
  change to a POST route; it plants a real (throwaway) key in three bodies and
  fails if one is accepted.

## Licensing

By contributing you agree that your contribution is licensed under the MIT
license, the same as Obsyd itself.

## Git hooks (optional)

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-commit` runs a secret scan so a `pool.json`-style key can never be
staged by accident.
