//! Obsyd wallet factory.
//!
//! Deploys passkey smart-contract wallets at **deterministic addresses**:
//! `contract_id = sha256(factory_address || salt)` with `salt = sha256(owner_passkey_public_key)`.
//!
//! That gives the two properties a smart-contract wallet needs to feel like a
//! normal account:
//!
//! * **Counterfactual receive.** `preview_address` returns the wallet's address
//!   before any transaction is sent, so the app can show a QR code and accept
//!   funds on first launch — nothing has to be deployed to be paid into.
//! * **No front-runnable setup.** Deployment and initialization happen in one
//!   `create_account` call whose constructor arguments are the owner's credential,
//!   so there is no window where a pending wallet could be claimed by someone else.
//!
//! The factory also keeps the registry the frontend reads (`address_of`) and pins
//! the approved wallet WASM hash, so a user never has to trust a caller-supplied
//! build.

#![no_std]

#[cfg(test)]
extern crate alloc;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    IntoVal, Val, Vec,
};

/// Ledger count to extend storage to on write — the same window the account
/// contract uses, so a wallet and its registry entry lapse together rather than
/// the registry going first.
const EXTEND_TO: u32 = 40_000;
/// Below this remaining lifetime an entry is due for extension.
const EXTEND_MIN: u32 = 20_000;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum FactoryError {
    NotInitialized = 1,
    TooManyAccounts = 2,
    NoWasmHash = 3,
    AccountExists = 4,
    BadPublicKey = 5,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    WasmHash,
    Registry(BytesN<32>),
    Salts,
    Count,
}

#[contracttype]
#[derive(Clone)]
pub struct Created {
    pub owner_public_key: BytesN<65>,
    pub account: Address,
}

fn owner_id(env: &Env, public_key: &BytesN<65>) -> BytesN<32> {
    env.crypto()
        .sha256(&Bytes::from(public_key.clone()))
        .to_bytes()
}

/// Push an entry this call already *read* forward by another window.
///
/// The host refuses to extend an entry outside the transaction footprint, so the
/// read above is what makes the bump legal. Missing entries are skipped.
fn bump_persistent<V>(env: &Env, key: &DataKey)
where
    V: IntoVal<Env, Val> + soroban_sdk::TryFromVal<Env, Val>,
{
    if env.storage().persistent().get::<DataKey, V>(key).is_some() {
        let seq = env.ledger().sequence();
        env.storage()
            .persistent()
            .extend_ttl(key, seq + EXTEND_MIN, seq + EXTEND_TO);
    }
}

/// The admin, refreshed as a side effect of being checked.
///
/// `initialize` would have been a public function, so whoever reached the factory
/// first would have become its admin. The constructor below runs inside the deploy
/// transaction instead, and the host reserves `__`-prefixed functions against
/// direct calls, so the recorded admin can never be claimed or re-pointed.
fn require_admin(env: &Env) -> Result<(), FactoryError> {
    let admin: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .ok_or(FactoryError::NotInitialized)?;
    admin.require_auth();
    bump_persistent::<Address>(env, &DataKey::Admin);
    Ok(())
}

/// The salt is derived from the owner credential, so the same passkey always
/// maps to the same address on a given factory, on a given network.
fn salt_for(env: &Env, public_key: &BytesN<65>) -> BytesN<32> {
    owner_id(env, public_key)
}

fn check_public_key(public_key: &BytesN<65>) -> Result<(), FactoryError> {
    let pk = Bytes::from(public_key.clone());
    if pk.len() != 65 || pk.get_unchecked(0) != 0x04 {
        return Err(FactoryError::BadPublicKey);
    }
    Ok(())
}

/// Write a persistent entry and push its lifetime forward.
///
/// A registry entry that lapses is worse than a revert: `address_of` would answer
/// "no wallet here" for a funded address, and nothing can put the entry back.
fn write_persistent<K, V>(env: &Env, key: &K, value: &V)
where
    K: IntoVal<Env, Val> + Clone,
    V: IntoVal<Env, Val> + Clone,
{
    env.storage().persistent().set(key, value);
    let seq = env.ledger().sequence();
    env.storage()
        .persistent()
        .extend_ttl(key, seq + EXTEND_MIN, seq + EXTEND_TO);
}

/// The account count after one more registration, refused if it would overflow.
fn next_count(env: &Env) -> Result<u32, FactoryError> {
    env.storage()
        .persistent()
        .get::<DataKey, u32>(&DataKey::Count)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(FactoryError::TooManyAccounts)
}

/// Record `account` for `id` and keep the enumeration consistent with it.
///
/// `accounts()` and `count()` are what the app pages through; a wallet that only
/// lands in `Registry` is invisible to them, so every registration writes all three.
fn write_registry(env: &Env, id: BytesN<32>, account: &Address, count: u32) {
    write_persistent(env, &DataKey::Registry(id.clone()), account);

    let mut salts = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::Salts)
        .unwrap_or_else(|| Vec::new(env));
    salts.push_back(id);
    write_persistent(env, &DataKey::Salts, &salts);
    write_persistent(env, &DataKey::Count, &count);

    let seq = env.ledger().sequence();
    env.storage()
        .instance()
        .extend_ttl(seq + EXTEND_MIN, seq + EXTEND_TO);
}

#[contract]
pub struct ObsydFactory;

#[contractimpl]
impl ObsydFactory {
    /// Runs inside the deploy transaction, so the factory is born with its admin
    /// and can never be claimed by whoever calls first.
    ///
    /// The `__` prefix is reserved by the host, which is what makes this
    /// one-shot: no later transaction can hand the factory a new admin. The
    /// approved wallet build is pinned separately through `set_wasm_hash`.
    pub fn __constructor(env: Env, admin: Address) {
        write_persistent(&env, &DataKey::Admin, &admin);
        let seq = env.ledger().sequence();
        env.storage()
            .instance()
            .extend_ttl(seq + EXTEND_MIN, seq + EXTEND_TO);
    }

    /// Point the factory at a reviewed build of `obsyd_account`.
    pub fn set_wasm_hash(env: Env, wasm_hash: BytesN<32>) -> Result<(), FactoryError> {
        require_admin(&env)?;
        write_persistent(&env, &DataKey::WasmHash, &wasm_hash);
        env.events()
            .publish((symbol_short!("obsyd"), symbol_short!("wasm")), wasm_hash);
        Ok(())
    }

    pub fn set_admin(env: Env, admin: Address) -> Result<(), FactoryError> {
        require_admin(&env)?;
        write_persistent(&env, &DataKey::Admin, &admin);
        Ok(())
    }

    /// The address a wallet for this credential would occupy. Safe to hand out as
    /// a receiving address before deployment.
    pub fn preview_address(env: Env, owner_public_key: BytesN<65>) -> Result<Address, FactoryError> {
        check_public_key(&owner_public_key)?;
        if !env.storage().persistent().has(&DataKey::WasmHash) {
            return Err(FactoryError::NoWasmHash);
        }
        Ok(env
            .deployer()
            .with_current_contract(salt_for(&env, &owner_public_key))
            .deployed_address())
    }

    /// Deploy and initialize a wallet for `owner_public_key` in one call.
    ///
    /// The account contract's `__constructor` registers the credential and pins
    /// the relying-party policy, so the instance is never usable in a
    /// half-configured state.
    pub fn create_account(
        env: Env,
        owner_public_key: BytesN<65>,
        rp_id_hash: BytesN<32>,
        origin: Bytes,
        require_user_presence: bool,
        require_user_verification: bool,
        allow_backup_eligible: bool,
    ) -> Result<Address, FactoryError> {
        check_public_key(&owner_public_key)?;
        let id = owner_id(&env, &owner_public_key);
        if env.storage().persistent().has(&DataKey::Registry(id.clone())) {
            return Err(FactoryError::AccountExists);
        }
        let wasm_hash: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::WasmHash)
            .ok_or(FactoryError::NoWasmHash)?;
        // Deploying is also how the factory keeps the build it deploys and the
        // admin who pinned it from lapsing underneath it.
        bump_persistent::<BytesN<32>>(&env, &DataKey::WasmHash);

        // Checked before deploying: a wallet that went out unregistered would be
        // invisible to `address_of` with no way to retry.
        let count = next_count(&env)?;

        let deployer = env
            .deployer()
            .with_current_contract(salt_for(&env, &owner_public_key));
        let account = deployer.deploy_v2(
            wasm_hash,
            (
                owner_public_key.clone(),
                rp_id_hash,
                origin,
                require_user_presence,
                require_user_verification,
                allow_backup_eligible,
            ),
        );

        write_registry(&env, id, &account, count);

        env.events().publish(
            (symbol_short!("obsyd"), symbol_short!("created")),
            Created {
                owner_public_key,
                account: account.clone(),
            },
        );
        Ok(account)
    }

    /// Record a wallet that was deployed directly (not through this factory), so
    /// the registry stays authoritative for the app. Admin-only to keep lookups
    /// trustworthy.
    pub fn register_account(
        env: Env,
        owner_public_key: BytesN<65>,
        account: Address,
    ) -> Result<(), FactoryError> {
        require_admin(&env)?;
        check_public_key(&owner_public_key)?;
        let id = owner_id(&env, &owner_public_key);
        if env.storage().persistent().has(&DataKey::Registry(id.clone())) {
            return Err(FactoryError::AccountExists);
        }
        let count = next_count(&env)?;
        write_registry(&env, id, &account, count);
        Ok(())
    }

    // ── views ─────────────────────────────────────────────────────────────────

    pub fn address_of(env: Env, owner_public_key: BytesN<65>) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Registry(owner_id(&env, &owner_public_key)))
    }

    pub fn wasm_hash(env: Env) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::WasmHash)
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    pub fn count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Count)
            .unwrap_or(0)
    }

    pub fn accounts(env: Env) -> Vec<Address> {
        let mut out = Vec::new(&env);
        let salts = env
            .storage()
            .persistent()
            .get::<DataKey, Vec<BytesN<32>>>(&DataKey::Salts)
            .unwrap_or_else(|| Vec::new(&env));
        for id in salts.iter() {
            if let Some(a) = env
                .storage()
                .persistent()
                .get::<DataKey, Address>(&DataKey::Registry(id))
            {
                out.push_back(a);
            }
        }
        out
    }
}
