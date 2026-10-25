//! Persistent state for an Obsyd wallet contract.
//!
//! Every key is instance-independent (this contract *is* the wallet), so one
//! storage namespace holds the signer set, the auth policy, the session keys,
//! the per-token spend limits and the guardian recovery configuration.
//!
//! TTL: the ledger only lets persistent entries be pushed forward a bounded
//! number of ledgers (≈63,450 on testnet). We extend by 40,000 ledgers on every
//! write and every read that matters, which keeps an idle wallet alive for
//! roughly a week of ledgers between uses without ever hitting the cap.

use soroban_sdk::{
    contracttype, symbol_short, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

/// Ledger count to extend to on write.
const EXTEND_TO: u32 = 40_000;
/// Below this remaining lifetime an entry is considered due for extension.
const EXTEND_MIN: u32 = 20_000;

/// A registered WebAuthn credential (platform or roaming authenticator).
#[contracttype]
#[derive(Clone)]
pub struct PasskeyInfo {
    /// SEC1 uncompressed point: 0x04 || X || Y for P-256.
    pub public_key: BytesN<65>,
    pub label: Symbol,
    pub added_at: u64,
}

/// Relying-party constraints an assertion has to satisfy.
#[contracttype]
#[derive(Clone)]
pub struct Policy {
    /// SHA-256 of the RP id (the wallet's web origin), first 32 bytes of authData.
    pub rp_id_hash: BytesN<32>,
    /// `origin` string inside clientDataJSON. Empty Bytes disables the check.
    pub origin: Bytes,
    pub require_user_presence: bool,
    /// Whether the authenticator must have verified the user (PIN / biometric /
    /// device unlock) for this assertion, i.e. the UV flag in authData.
    pub require_user_verification: bool,
    /// Backup-eligible / backup-state keys live in a synced credential store
    /// (iCloud / Google Password Manager). Off by default: a passkey that can
    /// silently migrate to another account is a weaker root of trust.
    pub allow_backup_eligible: bool,
}

/// A short-lived ed25519 key the owner elevated with a passkey assertion.
/// Cheap to sign with (no user prompt), capped by function allowlist + spend limits.
#[contracttype]
#[derive(Clone)]
pub struct Session {
    pub public_key: BytesN<32>,
    pub label: Symbol,
    /// Ledger timestamp (seconds) after which the key is unusable.
    pub expires_at: u64,
}

/// Moving-window cap on `transfer`-shaped calls authorized by a session key.
#[contracttype]
#[derive(Clone)]
pub struct SpendLimit {
    pub amount: i128,
    pub period_secs: u64,
    pub window_start: u64,
    pub spent: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct RecoveryParams {
    pub threshold: u32,
    pub timelock_secs: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct PendingRecovery {
    pub new_public_key: BytesN<65>,
    pub opened_at: u64,
    pub ready_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Initialized,
    Passkey(BytesN<32>),
    PasskeyIds,
    PasskeyNonce(BytesN<32>),
    Policy,
    Session(BytesN<32>),
    SessionIds,
    SessionNonce(BytesN<32>),
    Limit(Address),
    LimitTokens,
    Guardian(Address),
    Guardians,
    RecoveryParams,
    PendingRecovery,
}

/// Stable handle for a credential: sha256 over the SEC1 encoding.
pub fn passkey_id(env: &Env, public_key: &BytesN<65>) -> BytesN<32> {
    env.crypto()
        .sha256(&Bytes::from(public_key.clone()))
        .to_bytes()
}

pub fn session_id(env: &Env, public_key: &BytesN<32>) -> BytesN<32> {
    env.crypto()
        .sha256(&Bytes::from(public_key.clone()))
        .to_bytes()
}

fn now(env: &Env) -> u64 {
    env.ledger().timestamp()
}

fn touch_instance(env: &Env) {
    let seq = env.ledger().sequence();
    env.storage()
        .instance()
        .extend_ttl(seq + EXTEND_MIN, seq + EXTEND_TO);
}

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

/// Push an entry this call only *read* forward by another window.
///
/// The host refuses to extend an entry the transaction has not touched, so the
/// read is part of the bump, not a waste. Missing entries are skipped.
fn bump_persistent<V>(env: &Env, key: &DataKey)
where
    V: soroban_sdk::TryFromVal<Env, Val>,
{
    if env.storage().persistent().get::<DataKey, V>(key).is_some() {
        let seq = env.ledger().sequence();
        env.storage()
            .persistent()
            .extend_ttl(key, seq + EXTEND_MIN, seq + EXTEND_TO);
    }
}

/// Keep alive everything an authorisation decision depended on.
///
/// `__check_auth` is a read-only decision apart from the nonce it advances, and
/// only writes extend a TTL. Without this, the signer set, the policy, the spend
/// caps and the recovery configuration would expire roughly `EXTEND_TO` ledgers
/// after deployment — the wallet would stop recognising its own passkeys, a
/// configured cap would silently become *no* cap, and there is no call that can
/// re-create any of it, so the funds would be stranded.
pub fn refresh_passkey_auth(env: &Env) {
    bump_key_material(env);
}

/// The same, for a session-key authorisation. The lease itself is kept alive
/// because a 7-day lease is longer than one TTL window; the other leases are
/// not, so an unused one is allowed to lapse on its own schedule.
pub fn refresh_session_auth(env: &Env, id: &BytesN<32>) {
    bump_key_material(env);
    bump_persistent::<Vec<BytesN<32>>>(env, &DataKey::SessionIds);
    bump_persistent::<Session>(env, &DataKey::Session(id.clone()));
}

/// Every credential, cap and guardian the wallet can still act on.
fn bump_key_material(env: &Env) {
    bump_persistent::<bool>(env, &DataKey::Initialized);
    bump_persistent::<Policy>(env, &DataKey::Policy);

    bump_persistent::<Vec<BytesN<32>>>(env, &DataKey::PasskeyIds);
    for id in passkey_ids(env).iter() {
        bump_persistent::<PasskeyInfo>(env, &DataKey::Passkey(id.clone()));
        bump_persistent::<u64>(env, &DataKey::PasskeyNonce(id));
    }

    bump_persistent::<Vec<Address>>(env, &DataKey::LimitTokens);
    for token in limit_tokens(env).iter() {
        bump_persistent::<SpendLimit>(env, &DataKey::Limit(token));
    }

    refresh_recovery_state(env);
    touch_instance(env);
}

/// Guardians, quorum and any pending request are the last resort when a passkey
/// is gone, so they get refreshed with the rest of the security state.
fn refresh_recovery_state(env: &Env) {
    bump_persistent::<RecoveryParams>(env, &DataKey::RecoveryParams);
    bump_persistent::<PendingRecovery>(env, &DataKey::PendingRecovery);
    bump_persistent::<Vec<Address>>(env, &DataKey::Guardians);
    for guardian in guardians(env).iter() {
        bump_persistent::<bool>(env, &DataKey::Guardian(guardian));
    }
}

// ── initialization ───────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().persistent().has(&DataKey::Initialized)
}

pub fn set_initialized(env: &Env) {
    write_persistent(env, &DataKey::Initialized, &true);
    touch_instance(env);
}

// ── passkeys ─────────────────────────────────────────────────────────────────

pub fn add_passkey(env: &Env, public_key: &BytesN<65>, label: Symbol) {
    let id = passkey_id(env, public_key);
    let info = PasskeyInfo {
        public_key: public_key.clone(),
        label,
        added_at: now(env),
    };
    write_persistent(env, &DataKey::Passkey(id.clone()), &info);
    write_persistent(env, &DataKey::PasskeyNonce(id.clone()), &0u64);

    let mut ids = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::PasskeyIds)
        .unwrap_or_else(|| Vec::new(env));
    ids.push_back(id);
    write_persistent(env, &DataKey::PasskeyIds, &ids);
    touch_instance(env);
}

pub fn has_passkey(env: &Env, public_key: &BytesN<65>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Passkey(passkey_id(env, public_key)))
}

pub fn remove_passkey(env: &Env, public_key: &BytesN<65>) -> bool {
    let id = passkey_id(env, public_key);
    if !env
        .storage()
        .persistent()
        .has(&DataKey::Passkey(id.clone()))
    {
        return false;
    }
    env.storage().persistent().remove(&DataKey::Passkey(id.clone()));
    env.storage().persistent().remove(&DataKey::PasskeyNonce(id.clone()));

    if let Some(mut ids) = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::PasskeyIds)
    {
        let mut i = 0u32;
        while i < ids.len() {
            if ids.get_unchecked(i) == id {
                ids.remove(i);
                break;
            }
            i += 1;
        }
        write_persistent(env, &DataKey::PasskeyIds, &ids);
    }
    true
}

pub fn passkeys(env: &Env) -> Vec<BytesN<65>> {
    let mut out = Vec::new(env);
    let ids = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::PasskeyIds);
    let Some(ids) = ids else {
        return out;
    };
    for id in ids.iter() {
        if let Some(info) = env
            .storage()
            .persistent()
            .get::<DataKey, PasskeyInfo>(&DataKey::Passkey(id))
        {
            out.push_back(info.public_key);
        }
    }
    out
}

pub fn passkey_ids(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::PasskeyIds)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn passkey_count(env: &Env) -> u32 {
    env.storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::PasskeyIds)
        .map(|v| v.len())
        .unwrap_or(0)
}

pub fn get_policy(env: &Env) -> Option<Policy> {
    env.storage()
        .persistent()
        .get::<DataKey, Policy>(&DataKey::Policy)
}

pub fn set_policy(env: &Env, policy: &Policy) {
    write_persistent(env, &DataKey::Policy, policy);
}

// ── replay counters ──────────────────────────────────────────────────────────

pub fn get_nonce(env: &Env, key: &DataKey) -> u64 {
    env.storage()
        .persistent()
        .get::<DataKey, u64>(key)
        .unwrap_or(0)
}

pub fn set_nonce(env: &Env, key: &DataKey, nonce: u64) {
    write_persistent(env, key, &nonce);
}

// ── session keys ─────────────────────────────────────────────────────────────

pub fn set_session(env: &Env, session: &Session) {
    let id = session_id(env, &session.public_key);
    write_persistent(env, &DataKey::Session(id.clone()), session);
    write_persistent(env, &DataKey::SessionNonce(id.clone()), &0u64);

    let mut ids = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::SessionIds)
        .unwrap_or_else(|| Vec::new(env));
    if !ids.contains(&id) {
        ids.push_back(id);
    }
    write_persistent(env, &DataKey::SessionIds, &ids);
}

pub fn get_session(env: &Env, id: &BytesN<32>) -> Option<Session> {
    env.storage()
        .persistent()
        .get::<DataKey, Session>(&DataKey::Session(id.clone()))
}

pub fn revoke_session(env: &Env, id: &BytesN<32>) -> bool {
    if !env.storage().persistent().has(&DataKey::Session(id.clone())) {
        return false;
    }
    env.storage().persistent().remove(&DataKey::Session(id.clone()));
    env.storage().persistent().remove(&DataKey::SessionNonce(id.clone()));
    if let Some(mut ids) = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::SessionIds)
    {
        let mut i = 0u32;
        while i < ids.len() {
            if ids.get_unchecked(i) == *id {
                ids.remove(i);
                break;
            }
            i += 1;
        }
        write_persistent(env, &DataKey::SessionIds, &ids);
    }
    true
}

pub fn session_ids(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get::<DataKey, Vec<BytesN<32>>>(&DataKey::SessionIds)
        .unwrap_or_else(|| Vec::new(env))
}

// ── spend limits ─────────────────────────────────────────────────────────────

pub fn set_limit(env: &Env, token: &Address, limit: &SpendLimit) {
    write_persistent(env, &DataKey::Limit(token.clone()), limit);
    let mut tokens = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<Address>>(&DataKey::LimitTokens)
        .unwrap_or_else(|| Vec::new(env));
    if !tokens.contains(token) {
        tokens.push_back(token.clone());
    }
    write_persistent(env, &DataKey::LimitTokens, &tokens);
}

pub fn get_limit(env: &Env, token: &Address) -> Option<SpendLimit> {
    env.storage()
        .persistent()
        .get::<DataKey, SpendLimit>(&DataKey::Limit(token.clone()))
}

pub fn remove_limit(env: &Env, token: &Address) {
    env.storage().persistent().remove(&DataKey::Limit(token.clone()));
    if let Some(mut tokens) = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<Address>>(&DataKey::LimitTokens)
    {
        let mut i = 0u32;
        while i < tokens.len() {
            if tokens.get_unchecked(i) == *token {
                tokens.remove(i);
                break;
            }
            i += 1;
        }
        write_persistent(env, &DataKey::LimitTokens, &tokens);
    }
}

pub fn limit_tokens(env: &Env) -> Vec<Address> {
    env.storage()
        .persistent()
        .get::<DataKey, Vec<Address>>(&DataKey::LimitTokens)
        .unwrap_or_else(|| Vec::new(env))
}

/// Roll the window, add `amount` to what has already left the wallet this
/// window, and persist. Returns false when the cap would be exceeded — the
/// caller decides the error.
pub fn try_charge(env: &Env, token: &Address, amount: i128) -> bool {
    let mut limit = match get_limit(env, token) {
        Some(l) => l,
        None => return true, // no cap configured for this token
    };
    let ts = now(env);
    if limit.period_secs > 0 && ts >= limit.window_start + limit.period_secs {
        limit.window_start = ts;
        limit.spent = 0;
    }
    let Some(next) = limit.spent.checked_add(amount) else {
        return false;
    };
    if next > limit.amount {
        return false;
    }
    limit.spent = next;
    set_limit(env, token, &limit);
    true
}

// ── guardians / recovery ─────────────────────────────────────────────────────

pub fn add_guardian(env: &Env, guardian: &Address) {
    write_persistent(env, &DataKey::Guardian(guardian.clone()), &true);
    let mut list = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<Address>>(&DataKey::Guardians)
        .unwrap_or_else(|| Vec::new(env));
    if !list.contains(guardian) {
        list.push_back(guardian.clone());
    }
    write_persistent(env, &DataKey::Guardians, &list);
}

pub fn remove_guardian(env: &Env, guardian: &Address) -> bool {
    if !env
        .storage()
        .persistent()
        .has(&DataKey::Guardian(guardian.clone()))
    {
        return false;
    }
    env.storage()
        .persistent()
        .remove(&DataKey::Guardian(guardian.clone()));
    if let Some(mut list) = env
        .storage()
        .persistent()
        .get::<DataKey, Vec<Address>>(&DataKey::Guardians)
    {
        let mut i = 0u32;
        while i < list.len() {
            if list.get_unchecked(i) == *guardian {
                list.remove(i);
                break;
            }
            i += 1;
        }
        write_persistent(env, &DataKey::Guardians, &list);
    }
    true
}

pub fn is_guardian(env: &Env, guardian: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Guardian(guardian.clone()))
}

pub fn guardians(env: &Env) -> Vec<Address> {
    env.storage()
        .persistent()
        .get::<DataKey, Vec<Address>>(&DataKey::Guardians)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_recovery_params(env: &Env, params: &RecoveryParams) {
    write_persistent(env, &DataKey::RecoveryParams, params);
}

pub fn get_recovery_params(env: &Env) -> Option<RecoveryParams> {
    env.storage()
        .persistent()
        .get::<DataKey, RecoveryParams>(&DataKey::RecoveryParams)
}

pub fn set_pending_recovery(env: &Env, pending: &PendingRecovery) {
    write_persistent(env, &DataKey::PendingRecovery, pending);
}

pub fn get_pending_recovery(env: &Env) -> Option<PendingRecovery> {
    env.storage()
        .persistent()
        .get::<DataKey, PendingRecovery>(&DataKey::PendingRecovery)
}

pub fn clear_pending_recovery(env: &Env) {
    env.storage().persistent().remove(&DataKey::PendingRecovery);
}

/// Event topic shared by every wallet event.
pub fn topic() -> Symbol {
    symbol_short!("obsyd")
}
