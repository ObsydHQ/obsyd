## What changes

<!-- The user-visible outcome, not a file list. "A leaked session key can no
longer start recovery", not "edited lib.rs". -->

## Why

<!-- Link the issue this closes, or say "no issue — <reason>". -->

Closes #

## Which layer

- [ ] `contracts/` (Rust / Soroban)
- [ ] `frontend/wallet` UI
- [ ] `frontend/wallet` API routes
- [ ] docs only

## I ran these and they pass

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `cargo test --workspace` (in `contracts/`) — if a contract changed
- [ ] `cargo check --workspace --release --target wasm32v1-none` — if a contract changed
- [ ] `node frontend/wallet/scripts/probe-swap.mjs` — if the swap path changed

## Contract-specific

<!-- Delete if untouched. -->

- [ ] Every new failure mode has its own error variant and a test that triggers it
- [ ] A new mutating function is either on the session denylist (`is_admin_fn`)
      or the PR says out loud why it isn't
- [ ] New state is written through `write_persistent` (TTL extended)
- [ ] A bypass test exists that fails before the change and passes after

## Security

- [ ] No secret key crosses an HTTP boundary (`SECURITY.md` endpoint table is
      still true, and `app/api/**` never constructs a keypair)
- [ ] `docs/PASSKEY_CONTRACT.md` / `SECURITY.md` / `ARCHITECTURE.md` moved with
      the code, or this PR explains why they don't need to
- [ ] `CHANGELOG.md` has a line under Unreleased

## Screens

<!-- Required for UI changes; a short clip is fine for animation. -->
