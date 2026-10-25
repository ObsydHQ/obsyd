//! Obsyd — passkey smart-contract wallet for Stellar Soroban.
//!
//! This contract *is* the wallet: a Soroban custom account whose signer set is a
//! set of WebAuthn credentials. Holding the passkey is holding the wallet; there
//! is no seed phrase and no private key in local storage.
//!
//! Two credential paths are supported:
//!
//! * **Passkey assertion** (`webauthn::Assertion`) — the full-power owner path.
//!   Verified on-chain with the `secp256r1` precompile against a registered
//!   credential, bound to the RP id, the ceremony type, the pinned origin and the
//!   host-computed auth payload.
//! * **Session key** (`Vec[session_id, ed25519_sig, nonce]`) — a temporary ed25519
//!   key the owner elevated with a passkey. Cheap to sign with, so everyday sends
//!   do not prompt Face ID, and capped by an expiry, a function denylist and
//!   per-token spend limits.
//!
//! Guardians provide account recovery: if the passkey is lost, a threshold of
//! pre-approved guardian addresses can move the wallet to a new credential after
//! a timelock, with the owner's key still able to cancel nothing — the timelock is
//! what gives the owner time to react.
//!
//! ```text
//!   ┌────────────┐  WebAuthn get()   ┌──────────────────┐
//!   │ authenticator│ ───────────────▶ │ assertion struct  │
//!   └────────────┘                   └────────┬─────────┘
//!                                             │ SorobanAuthorizationEntry.signature
//!   unsigned tx ─▶ simulate ─▶ signature_payload ─▶ __check_auth ─▶ secp256r1 ─▶ ok
//! ```

#![no_std]

#[cfg(test)]
extern crate alloc;

use soroban_sdk::{
    auth::{Context, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, symbol_short, Address, Bytes, BytesN, Env,
    Symbol, TryFromVal, Val, Vec,
};

mod storage;
mod webauthn;

#[cfg(test)]
mod test;

use storage::{DataKey, Policy, RecoveryParams, Session, SpendLimit};
use webauthn::Assertion;

/// Longest session-key lease the wallet will accept (7 days).
const MAX_SESSION_TTL: u64 = 7 * 24 * 60 * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    BadPublicKey = 3,
    AuthDataTooShort = 4,
    AuthDataAttested = 5,
    WrongRpId = 6,
    UserPresenceRequired = 7,
    UserVerificationRequired = 8,
    BackupKeyNotAllowed = 9,
    BadClientData = 10,
    ChallengeMismatch = 11,
    BadOrigin = 12,
    UnknownPasskey = 13,
    PasskeyExists = 14,
    LastPasskey = 15,
    NonceMismatch = 16,
    InvalidSignature = 17,
    SessionUnknown = 18,
    SessionExpired = 19,
    ForbiddenForSession = 20,
    SpendLimitExceeded = 21,
    BadArgs = 22,
    NoGuardians = 23,
    NotAGuardian = 24,
    DuplicateGuardian = 25,
    QuorumNotMet = 26,
    TimelockNotElapsed = 27,
    NoRecoveryPending = 28,
    RecoveryInProgress = 29,
    GuardianExists = 30,
}

#[contract]
pub struct ObsydAccount;

/// Admin-only entry points. A session key can never authorize these: leaking a
/// session key must not be able to take over the wallet.
///
/// `execute` belongs here for a non-obvious reason: it re-authorizes a call tree
/// as the wallet itself, so a lease that could reach it would bypass this very
/// list by batching `add_passkey` through the inner tree.
fn is_admin_fn(env: &Env, name: &Symbol) -> bool {
    const NAMES: [&str; 17] = [
        "add_passkey",
        "remove_passkey",
        "rotate_passkey",
        "set_policy",
        "elevate_session",
        "revoke_session",
        "revoke_all",
        "set_spend_limit",
        "clear_spend_limit",
        "add_guardian",
        "remove_guardian",
        "set_recovery",
        "begin_recovery",
        "execute_recovery",
        "cancel_recovery",
        "execute",
        "upgrade",
    ];
    for n in NAMES {
        if *name == Symbol::new(env, n) {
            return true;
        }
    }
    false
}

/// Sum the value leaving this wallet through `transfer(from, to, amount)` calls
/// on `token` among the authorized contexts, so it can be checked against the cap.
///
/// `Ok(None)` means nothing moves out of the wallet for that token. A malformed
/// or negative amount is an error rather than a free pass.
fn outgoing_for(
    env: &Env,
    token: &Address,
    contexts: &Vec<Context>,
) -> Result<Option<i128>, AccountError> {
    let me = env.current_contract_address();
    let mut total: i128 = 0;
    let mut matched = false;
    for ctx in contexts.iter() {
        let Context::Contract(c) = ctx else {
            continue;
        };
        if c.contract != *token || c.fn_name != symbol_short!("transfer") || c.args.len() != 3 {
            continue;
        }
        let Ok(from) = Address::try_from_val(env, &c.args.get_unchecked(0)) else {
            continue;
        };
        if from != me {
            continue;
        }
        let amount = i128::try_from_val(env, &c.args.get_unchecked(2))
            .map_err(|_| AccountError::SpendLimitExceeded)?;
        if amount < 0 {
            return Err(AccountError::SpendLimitExceeded);
        }
        matched = true;
        total = total.checked_add(amount).ok_or(AccountError::SpendLimitExceeded)?;
    }
    Ok(matched.then_some(total))
}

/// Revoke every live session lease. Internal: callers are already authorized, and
/// a nested `require_auth` would consume a second replay counter.
fn revoke_all_sessions(env: &Env) {
    for id in storage::session_ids(env).iter() {
        storage::revoke_session(env, &id);
    }
}

#[contractimpl]
impl ObsydAccount {
    /// Deploy-time initialization. Reached through the factory
    /// (`deploy_v2` with these constructor args), which is what closes the
    /// front-running window a separate `initialize` call would leave open.
    /// The `__` prefix is reserved by the host, so this can never be re-invoked
    /// on a live wallet to hand it a new owner.
    pub fn __constructor(
        env: Env,
        owner_public_key: BytesN<65>,
        rp_id_hash: BytesN<32>,
        origin: Bytes,
        require_user_presence: bool,
        require_user_verification: bool,
        allow_backup_eligible: bool,
    ) {
        let pk = Bytes::from(owner_public_key.clone());
        assert!(pk.len() == 65 && pk.get_unchecked(0) == 0x04, "bad SEC1 key");
        storage::set_initialized(&env);
        storage::set_policy(
            &env,
            &Policy {
                rp_id_hash,
                origin,
                require_user_presence,
                require_user_verification,
                allow_backup_eligible,
            },
        );
        storage::add_passkey(&env, &owner_public_key, symbol_short!("owner"));
        env.events().publish(
            (storage::topic(), symbol_short!("created")),
            owner_public_key,
        );
    }

    // ── Soroban custom-account entry point ───────────────────────────────────

    /// Called by the host before any invocation authorized by this wallet runs.
    ///
    /// `signature_payload` is the host's hash over the authorized tree, so it is
    /// the natural WebAuthn challenge: an assertion recorded for one transaction
    /// cannot be replayed onto another.
    pub fn __check_auth(
        env: Env,
        signature_payload: BytesN<32>,
        signature: Val,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        if !storage::is_initialized(&env) {
            return Err(AccountError::NotInitialized);
        }

        // ── Path 1: passkey assertion (owner, unrestricted) ───────────────────
        if let Ok(assertion) = Assertion::try_from_val(&env, &signature) {
            let policy = storage::get_policy(&env).ok_or(AccountError::NotInitialized)?;
            if !storage::has_passkey(&env, &assertion.public_key) {
                return Err(AccountError::UnknownPasskey);
            }
            let id = storage::passkey_id(&env, &assertion.public_key);
            let key = DataKey::PasskeyNonce(id);
            let stored = storage::get_nonce(&env, &key);
            if assertion.nonce != stored {
                return Err(AccountError::NonceMismatch);
            }

            let counter = webauthn::verify(&env, &assertion, &signature_payload, &policy)?;

            // Only advance the replay counter once the signature really verified.
            storage::set_nonce(&env, &key, stored + 1);
            // Every successful passkey authorization is also the wallet's way of
            // keeping its own security state alive; only writes extend a TTL.
            storage::refresh_passkey_auth(&env);
            env.events().publish(
                (storage::topic(), symbol_short!("passkey")),
                (assertion.nonce, counter),
            );
            return Ok(());
        }

        // ── Path 2: session key (scoped, capped) ──────────────────────────────
        if let Ok(parts) = Vec::<Val>::try_from_val(&env, &signature) {
            if parts.len() == 3 {
                let Ok(id) = BytesN::<32>::try_from_val(&env, &parts.get_unchecked(0)) else {
                    return Err(AccountError::InvalidSignature);
                };
                let Ok(sig) = BytesN::<64>::try_from_val(&env, &parts.get_unchecked(1)) else {
                    return Err(AccountError::InvalidSignature);
                };
                let Ok(nonce) = u64::try_from_val(&env, &parts.get_unchecked(2)) else {
                    return Err(AccountError::InvalidSignature);
                };

                let session =
                    storage::get_session(&env, &id).ok_or(AccountError::SessionUnknown)?;
                if env.ledger().timestamp() >= session.expires_at {
                    return Err(AccountError::SessionExpired);
                }
                let key = DataKey::SessionNonce(id.clone());
                let stored = storage::get_nonce(&env, &key);
                if nonce != stored {
                    return Err(AccountError::NonceMismatch);
                }

                // Traps on a bad signature, which aborts the transaction.
                env.crypto().ed25519_verify(
                    &session.public_key,
                    &Bytes::from(signature_payload.clone()),
                    &sig,
                );

                // Function denylist first: a leaked lease must not be able to
                // reconfigure the wallet.
                for ctx in auth_contexts.iter() {
                    let Context::Contract(c) = ctx else {
                        return Err(AccountError::ForbiddenForSession);
                    };
                    if is_admin_fn(&env, &c.fn_name) {
                        return Err(AccountError::ForbiddenForSession);
                    }
                }

                // Then the per-token caps, charged once per distinct token.
                let mut seen_tokens = Vec::<Address>::new(&env);
                for ctx in auth_contexts.iter() {
                    let Context::Contract(c) = ctx else {
                        continue;
                    };
                    if seen_tokens.contains(&c.contract) {
                        continue;
                    }
                    seen_tokens.push_back(c.contract.clone());
                    if storage::get_limit(&env, &c.contract).is_none() {
                        continue;
                    }
                    let Some(amount) = outgoing_for(&env, &c.contract, &auth_contexts)? else {
                        continue;
                    };
                    if !storage::try_charge(&env, &c.contract, amount) {
                        return Err(AccountError::SpendLimitExceeded);
                    }
                }

                storage::set_nonce(&env, &key, stored + 1);
                storage::refresh_session_auth(&env, &id);
                env.events()
                    .publish((storage::topic(), symbol_short!("session")), (id, nonce));
                return Ok(());
            }
        }

        Err(AccountError::InvalidSignature)
    }

    // ── signer management (owner only) ────────────────────────────────────────

    /// Register an additional passkey (a second device, a security key).
    pub fn add_passkey(env: Env, public_key: BytesN<65>, label: Symbol) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if storage::has_passkey(&env, &public_key) {
            return Err(AccountError::PasskeyExists);
        }
        let pk = Bytes::from(public_key.clone());
        if pk.len() != 65 || pk.get_unchecked(0) != 0x04 {
            return Err(AccountError::BadPublicKey);
        }
        storage::add_passkey(&env, &public_key, label);
        env.events().publish(
            (storage::topic(), symbol_short!("key_add")),
            public_key,
        );
        Ok(())
    }

    /// Remove a passkey. Refuses to leave the wallet with no owner key.
    pub fn remove_passkey(env: Env, public_key: BytesN<65>) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if storage::passkey_count(&env) <= 1 {
            return Err(AccountError::LastPasskey);
        }
        if !storage::remove_passkey(&env, &public_key) {
            return Err(AccountError::UnknownPasskey);
        }
        env.events().publish(
            (storage::topic(), symbol_short!("key_rm")),
            public_key,
        );
        Ok(())
    }

    /// Swap a lost or replaced device's credential for a new one, keeping the
    /// same contract address — and therefore the same balances.
    pub fn rotate_passkey(
        env: Env,
        old_public_key: BytesN<65>,
        new_public_key: BytesN<65>,
        label: Symbol,
    ) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if old_public_key == new_public_key {
            return Err(AccountError::BadArgs);
        }
        if storage::has_passkey(&env, &new_public_key) {
            return Err(AccountError::PasskeyExists);
        }
        let pk = Bytes::from(new_public_key.clone());
        if pk.len() != 65 || pk.get_unchecked(0) != 0x04 {
            return Err(AccountError::BadPublicKey);
        }
        if !storage::remove_passkey(&env, &old_public_key) {
            return Err(AccountError::UnknownPasskey);
        }
        storage::add_passkey(&env, &new_public_key, label);
        // A rotated signer must not inherit leases granted to the old key.
        revoke_all_sessions(&env);
        env.events().publish(
            (storage::topic(), symbol_short!("key_swap")),
            (old_public_key, new_public_key),
        );
        Ok(())
    }

    /// Change the relying-party constraints assertions are checked against.
    pub fn set_policy(
        env: Env,
        rp_id_hash: BytesN<32>,
        origin: Bytes,
        require_user_presence: bool,
        require_user_verification: bool,
        allow_backup_eligible: bool,
    ) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        storage::set_policy(
            &env,
            &Policy {
                rp_id_hash,
                origin,
                require_user_presence,
                require_user_verification,
                allow_backup_eligible,
            },
        );
        Ok(())
    }

    // ── session keys (owner only) ─────────────────────────────────────────────

    /// Grant a temporary ed25519 key the right to authorize ordinary calls
    /// without a passkey prompt.
    pub fn elevate_session(
        env: Env,
        public_key: BytesN<32>,
        label: Symbol,
        ttl_secs: u64,
    ) -> Result<BytesN<32>, AccountError> {
        env.current_contract_address().require_auth();
        if ttl_secs == 0 || ttl_secs > MAX_SESSION_TTL {
            return Err(AccountError::BadArgs);
        }
        let session = Session {
            public_key,
            label,
            expires_at: env.ledger().timestamp() + ttl_secs,
        };
        storage::set_session(&env, &session);
        let id = storage::session_id(&env, &session.public_key);
        env.events()
            .publish((storage::topic(), Symbol::new(&env, "session_up")), id.clone());
        Ok(id)
    }

    /// Revoke a session key by id (the value `elevate_session` returned).
    pub fn revoke_session(env: Env, id: BytesN<32>) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if !storage::revoke_session(&env, &id) {
            return Err(AccountError::SessionUnknown);
        }
        env.events()
            .publish((storage::topic(), symbol_short!("sess_dn")), id);
        Ok(())
    }

    /// Drop every live lease in one transaction.
    pub fn revoke_all(env: Env) {
        env.current_contract_address().require_auth();
        revoke_all_sessions(&env);
    }

    // ── spend limits (owner only) ─────────────────────────────────────────────

    /// Cap how much of `token` a session key may move out of the wallet inside a
    /// rolling `period_secs` window. Passkeys are exempt: they are the owner.
    pub fn set_spend_limit(
        env: Env,
        token: Address,
        amount: i128,
        period_secs: u64,
    ) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if amount < 0 {
            return Err(AccountError::BadArgs);
        }
        storage::set_limit(
            &env,
            &token,
            &SpendLimit {
                amount,
                period_secs,
                window_start: env.ledger().timestamp(),
                spent: 0,
            },
        );
        Ok(())
    }

    pub fn clear_spend_limit(env: Env, token: Address) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        storage::remove_limit(&env, &token);
        Ok(())
    }

    // ── guardians and recovery (owner only, except execute) ──────────────────

    pub fn add_guardian(env: Env, guardian: Address) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if storage::is_guardian(&env, &guardian) {
            return Err(AccountError::GuardianExists);
        }
        storage::add_guardian(&env, &guardian);
        env.events()
            .publish((storage::topic(), symbol_short!("guardian")), guardian);
        Ok(())
    }

    pub fn remove_guardian(env: Env, guardian: Address) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if !storage::remove_guardian(&env, &guardian) {
            return Err(AccountError::NotAGuardian);
        }
        Ok(())
    }

    /// Configure the recovery quorum. `threshold` must be within the guardian set
    /// and the timelock at least one hour, so a set cannot be backdated into an
    /// instant takeover.
    pub fn set_recovery(
        env: Env,
        threshold: u32,
        timelock_secs: u64,
    ) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        let count = storage::guardians(&env).len();
        if threshold == 0 || threshold > count {
            return Err(AccountError::NoGuardians);
        }
        if timelock_secs < 3600 {
            return Err(AccountError::BadArgs);
        }
        storage::set_recovery_params(
            &env,
            &RecoveryParams {
                threshold,
                timelock_secs,
            },
        );
        Ok(())
    }

    /// Anyone may open a recovery request: it does nothing on its own. It becomes
    /// actionable only after the timelock and only with `threshold` guardian
    /// signatures, so the owner keeps a window to rotate keys or move funds.
    pub fn begin_recovery(env: Env, new_public_key: BytesN<65>) -> Result<(), AccountError> {
        if !storage::is_initialized(&env) {
            return Err(AccountError::NotInitialized);
        }
        if storage::get_pending_recovery(&env).is_some() {
            return Err(AccountError::RecoveryInProgress);
        }
        if storage::get_recovery_params(&env).is_none() {
            return Err(AccountError::NoGuardians);
        }
        let pk = Bytes::from(new_public_key.clone());
        if pk.len() != 65 || pk.get_unchecked(0) != 0x04 {
            return Err(AccountError::BadPublicKey);
        }
        let params = storage::get_recovery_params(&env).ok_or(AccountError::NoGuardians)?;
        let now = env.ledger().timestamp();
        storage::set_pending_recovery(
            &env,
            &storage::PendingRecovery {
                new_public_key: new_public_key.clone(),
                opened_at: now,
                ready_at: now + params.timelock_secs,
            },
        );
        env.events().publish(
            (storage::topic(), symbol_short!("rec_open")),
            new_public_key,
        );
        Ok(())
    }

    /// Complete a pending recovery. The wallet's own auth is deliberately not
    /// required — that is the whole point: the owner's device is gone.
    ///
    /// `signers` must list distinct registered guardians whose ed25519
    /// authorizations are present in this transaction, at least `threshold` of
    /// them.
    pub fn execute_recovery(env: Env, signers: Vec<Address>) -> Result<BytesN<65>, AccountError> {
        let pending = storage::get_pending_recovery(&env).ok_or(AccountError::NoRecoveryPending)?;
        if env.ledger().timestamp() < pending.ready_at {
            return Err(AccountError::TimelockNotElapsed);
        }
        let params = storage::get_recovery_params(&env).ok_or(AccountError::NoGuardians)?;

        let mut seen = Vec::<Address>::new(&env);
        let mut approvals: u32 = 0;
        for signer in signers.iter() {
            if !storage::is_guardian(&env, &signer) {
                return Err(AccountError::NotAGuardian);
            }
            if seen.contains(&signer) {
                return Err(AccountError::DuplicateGuardian);
            }
            seen.push_back(signer.clone());
            // Aborts the transaction unless this guardian really signed it.
            signer.require_auth();
            approvals += 1;
        }
        if approvals < params.threshold {
            return Err(AccountError::QuorumNotMet);
        }

        // Replace the whole signer set, then wipe every lease and limit window
        // the lost key may have leaked.
        for old in storage::passkeys(&env).iter() {
            storage::remove_passkey(&env, &old);
        }
        storage::add_passkey(&env, &pending.new_public_key, symbol_short!("recovered"));
        let ids = storage::session_ids(&env);
        for id in ids.iter() {
            storage::revoke_session(&env, &id);
        }
        storage::clear_pending_recovery(&env);

        env.events().publish(
            (storage::topic(), symbol_short!("rec_done")),
            pending.new_public_key.clone(),
        );
        Ok(pending.new_public_key)
    }

    pub fn cancel_recovery(env: Env) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        if storage::get_pending_recovery(&env).is_none() {
            return Err(AccountError::NoRecoveryPending);
        }
        storage::clear_pending_recovery(&env);
        Ok(())
    }

    // ── batched execution ─────────────────────────────────────────────────────

    /// Run several contract calls as this wallet in one transaction, e.g.
    /// `approve` + `swap` against a Soroswap router.
    ///
    /// The tree is part of the authorized arguments, so it is covered by the same
    /// signature that authorized this call — a passkey prompt over `execute`
    /// cannot be talked into running something else.
    pub fn execute(
        env: Env,
        invocations: Vec<InvokerContractAuthEntry>,
    ) -> Result<Vec<Val>, AccountError> {
        env.current_contract_address().require_auth();
        env.authorize_as_current_contract(invocations.clone());

        let mut results = Vec::<Val>::new(&env);
        for entry in invocations.iter() {
            // Only sub-contract calls are replayed; a tree that also asks to
            // deploy a contract is rejected rather than silently ignored.
            let InvokerContractAuthEntry::Contract(SubContractInvocation { context, .. }) = entry
            else {
                return Err(AccountError::BadArgs);
            };
            results.push_back(env.invoke_contract::<Val>(
                &context.contract,
                &context.fn_name,
                context.args,
            ));
        }
        env.events().publish(
            (storage::topic(), symbol_short!("batch")),
            results.len(),
        );
        Ok(results)
    }

    /// Accept native XLM without a memo-only path (classic accounts can already
    /// receive, this exists for the contract-id path and for symmetry).
    pub fn receive(env: Env) {
        let _ = env;
    }

    /// Replace the wallet logic with an already-uploaded WASM build. The new code
    /// keeps this storage and this address; only the behaviour changes, so the
    /// owner must sign it with a passkey.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), AccountError> {
        env.current_contract_address().require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    // ── views ─────────────────────────────────────────────────────────────────

    pub fn version(env: Env) -> u32 {
        let _ = env;
        1
    }

    pub fn initialized(env: Env) -> bool {
        storage::is_initialized(&env)
    }

    pub fn get_policy(env: Env) -> Option<Policy> {
        storage::get_policy(&env)
    }

    pub fn get_passkeys(env: Env) -> Vec<BytesN<65>> {
        storage::passkeys(&env)
    }

    pub fn passkey_nonce(env: Env, public_key: BytesN<65>) -> u64 {
        let id = storage::passkey_id(&env, &public_key);
        storage::get_nonce(&env, &DataKey::PasskeyNonce(id))
    }

    pub fn session_nonce(env: Env, id: BytesN<32>) -> u64 {
        storage::get_nonce(&env, &DataKey::SessionNonce(id))
    }

    pub fn get_session(env: Env, id: BytesN<32>) -> Option<Session> {
        storage::get_session(&env, &id)
    }

    pub fn get_sessions(env: Env) -> Vec<Session> {
        let mut out = Vec::new(&env);
        for id in storage::session_ids(&env).iter() {
            if let Some(s) = storage::get_session(&env, &id) {
                out.push_back(s);
            }
        }
        out
    }

    pub fn get_spend_limit(env: Env, token: Address) -> Option<SpendLimit> {
        storage::get_limit(&env, &token)
    }

    /// Every token that currently has a rolling cap, so a UI can show the caps
    /// it enforces without guessing asset addresses.
    pub fn get_limited_tokens(env: Env) -> Vec<Address> {
        storage::limit_tokens(&env)
    }

    pub fn get_guardians(env: Env) -> Vec<Address> {
        storage::guardians(&env)
    }

    pub fn get_recovery(env: Env) -> Option<RecoveryParams> {
        storage::get_recovery_params(&env)
    }

    pub fn get_pending_recovery(env: Env) -> Option<storage::PendingRecovery> {
        storage::get_pending_recovery(&env)
    }
}
