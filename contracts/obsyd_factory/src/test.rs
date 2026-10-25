//! Unit tests for the wallet factory.
//!
//! `create_account` needs the wallet's compiled WASM uploaded first, which only
//! works against a real build, so these tests cover everything that does not:
//! admin gating, the pinned build hash, and — the part that actually matters for
//! correctness — that `preview_address` is deterministic, credential-bound and
//! matches what the registry records for a manually registered wallet.
//!
//! Note the client convention: `client.f(..)` returns the success value and
//! traps if the contract errored, so every error assertion goes through the
//! generated `try_f(..)` twin, whose error arm is `Result<FactoryError, _>`.

extern crate alloc;

use soroban_sdk::{
    testutils::Address as _, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

use crate::{owner_id, DataKey, FactoryError, ObsydFactory, ObsydFactoryClient};

fn key_in(env: &Env, seed: u8) -> BytesN<65> {
    let mut k = [0u8; 65];
    k[0] = 0x04;
    k[1] = seed;
    BytesN::from_array(env, &k)
}

/// The error a `try_*` call produced, panicking if it succeeded instead. The
/// success arm is generic because the client wraps it in another `Result`.
fn error_of<T>(
    got: Result<T, Result<FactoryError, soroban_sdk::InvokeError>>,
) -> FactoryError {
    got.err().expect("expected the call to fail").unwrap()
}

fn setup(env: &Env) -> (Address, ObsydFactoryClient<'_>) {
    env.mock_all_auths();
    // The admin arrives with the deploy transaction itself (see `__constructor`),
    // and the approved build is pinned afterwards by that admin.
    let factory = env.register(ObsydFactory, (Address::generate(env),));
    let client = ObsydFactoryClient::new(env, &factory);
    let _ = client.set_wasm_hash(&BytesN::from_array(env, &[9u8; 32]));
    (factory, client)
}

#[test]
fn the_constructor_records_the_admin_and_no_build() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let factory = env.register(ObsydFactory, (admin.clone(),));
    let client = ObsydFactoryClient::new(&env, &factory);

    assert_eq!(client.admin().unwrap(), admin);
    assert_eq!(
        client.wasm_hash(),
        None,
        "pinning a build is a separate, admin-gated decision"
    );
    assert_eq!(client.count(), 0);
}

/// The host reserves `__`-prefixed functions against direct calls, so nobody can
/// re-run the constructor on a live factory and move it to a new admin.
#[test]
fn a_live_factory_cannot_be_re_initialized() {
    let env = soroban_sdk::Env::default();
    let (factory, client) = setup(&env);
    let before = client.admin().unwrap();

    let attacker = Address::generate(&env);
    let outcome = env.try_invoke_contract::<(), FactoryError>(
        &factory,
        &Symbol::new(&env, "__constructor"),
        Vec::from_array(&env, [attacker.into_val(&env)]),
    );
    assert!(
        matches!(outcome, Err(Err(_))),
        "a reserved function must fail at the host, before the contract body"
    );
    assert_eq!(client.admin().unwrap(), before, "and the admin is unchanged");
}

#[test]
fn the_previewed_address_is_deterministic_and_credential_bound() {
    let env = soroban_sdk::Env::default();
    let (_, client) = setup(&env);

    let a = client.preview_address(&key_in(&env, 1));
    let a_again = client.preview_address(&key_in(&env, 1));
    let b = client.preview_address(&key_in(&env, 2));
    assert_eq!(a, a_again, "same credential → same address");
    assert_ne!(a, b, "different credential → different address");
}

#[test]
fn preview_needs_a_pinned_build() {
    let env = soroban_sdk::Env::default();
    let factory = env.register(ObsydFactory, (Address::generate(&env),));
    let client = ObsydFactoryClient::new(&env, &factory);
    let err = client.try_preview_address(&key_in(&env, 3));
    assert_eq!(error_of(err), FactoryError::NoWasmHash);
}

#[test]
fn a_malformed_public_key_is_refused() {
    let env = soroban_sdk::Env::default();
    let (_, client) = setup(&env);
    // 0x02 prefix (compressed) is not the SEC1 uncompressed shape ES256 gives.
    let mut bad = [0u8; 65];
    bad[0] = 0x02;
    let err = client.try_preview_address(&BytesN::from_array(&env, &bad));
    assert_eq!(error_of(err), FactoryError::BadPublicKey);
}

#[test]
fn rotation_of_the_approved_build_is_admin_scoped() {
    let env = soroban_sdk::Env::default();
    let (_, client) = setup(&env);
    // mock_all_auths means these succeed; the contract's own require_auth on the
    // recorded admin is what gates them in production.
    let _ = client.set_wasm_hash(&BytesN::from_array(&env, &[8u8; 32]));
    assert_eq!(client.wasm_hash().unwrap(), BytesN::from_array(&env, &[8u8; 32]));

    let new_admin = Address::generate(&env);
    let _ = client.set_admin(&new_admin);
    assert_eq!(client.admin().unwrap(), new_admin);

    // A caller who is not the recorded admin gets nowhere. There is no way to
    // mock "only this address may authorize", so the honest assertion is that the
    // call fails before the contract body runs: `require_auth` on the stored admin
    // traps at the host level, which surfaces as an InvokeError rather than a
    // FactoryError. A fresh env with no auth mocking is what makes that visible.
    let env2 = soroban_sdk::Env::default();
    let factory = env2.register(ObsydFactory, (Address::generate(&env2),));
    let client2 = ObsydFactoryClient::new(&env2, &factory);
    let outsider = ObsydFactoryClient::new(&env2, &factory);
    let outcome = outsider.try_set_wasm_hash(&BytesN::from_array(&env2, &[6u8; 32]));
    assert!(
        matches!(outcome, Err(Err(_))),
        "rotating the approved build without the admin's authorization must fail"
    );
    assert_eq!(
        client2.wasm_hash(),
        None,
        "and the rejected call left no build pinned"
    );
}

#[test]
fn registering_a_wallet_makes_it_resolvable() {
    let env = soroban_sdk::Env::default();
    let (_, client) = setup(&env);
    let owner = key_in(&env, 5);
    // The address a wallet would have, recorded as if deployed out of band.
    let wallet = client.preview_address(&owner);
    let _ = client.register_account(&owner, &wallet);

    assert_eq!(client.address_of(&owner).unwrap(), wallet);
    assert_eq!(client.accounts(), Vec::from_array(&env, [wallet.clone()]));
    assert_eq!(client.count(), 1, "and the enumeration count moved with it");

    let err = client.try_register_account(&owner, &wallet);
    assert_eq!(error_of(err), FactoryError::AccountExists);
}

#[test]
fn registry_entries_are_written_with_a_full_lifetime() {
    // An un-extended persistent entry lives 4096 ledgers, so a factory that never
    // refreshed its own state would start answering "no wallet here" for funded
    // addresses. Every write has to carry the full window.
    use soroban_sdk::testutils::storage::Persistent as _;

    let env = soroban_sdk::Env::default();
    let (factory, client) = setup(&env);
    let owner = key_in(&env, 7);
    let wallet = client.preview_address(&owner);
    let _ = client.register_account(&owner, &wallet);

    let wasm_ttl = env.as_contract(&factory, || {
        env.storage().persistent().get_ttl(&DataKey::WasmHash)
    });
    let entry_ttl = env.as_contract(&factory, || {
        env.storage()
            .persistent()
            .get_ttl(&DataKey::Registry(owner_id(&env, &owner)))
    });
    assert!(wasm_ttl >= 39_000, "the pinned build is about to lapse: {wasm_ttl}");
    assert!(
        entry_ttl >= 39_000,
        "the registry entry is about to lapse: {entry_ttl}"
    );
}

#[test]
fn an_unknown_credential_has_no_address() {
    let env = soroban_sdk::Env::default();
    let (_, client) = setup(&env);
    assert_eq!(client.address_of(&key_in(&env, 6)), None);
}

#[test]
fn two_factories_preview_different_addresses() {
    // The deployer address is part of the contract-id derivation, so a wallet for
    // the same credential lands on a different address per factory deployment.
    let env = soroban_sdk::Env::default();
    let a = client_of(&env).preview_address(&key_in(&env, 1));
    let b = client_of(&env).preview_address(&key_in(&env, 1));
    assert_ne!(a, b);
}

/// A factory that only exists to derive addresses from: pinning the build is
/// admin-gated, so this env has to authorize it.
fn client_of(env: &soroban_sdk::Env) -> ObsydFactoryClient<'_> {
    env.mock_all_auths();
    let factory = env.register(ObsydFactory, (Address::generate(env),));
    let client = ObsydFactoryClient::new(env, &factory);
    let _ = client.set_wasm_hash(&BytesN::from_array(env, &[9u8; 32]));
    client
}
