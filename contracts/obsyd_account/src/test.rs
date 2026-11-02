//! Unit tests for the Obsyd passkey account contract.
//!
//! The WebAuthn fixtures are cryptographically real: a P-256 key from the `p256`
//! crate signs `sha256(authenticatorData || sha256(clientDataJSON))`, exactly the
//! message a FIDO2 authenticator signs, so a green suite here means the on-chain
//! verifier agrees with what a browser produces.
//!
//! Run: `cargo test -p obsyd_account`

extern crate alloc;

use alloc::{format, string::String, vec, vec::Vec as StdVec};

use ed25519_dalek::{Signer, SigningKey as Ed25519SigningKey};
use p256::ecdsa::{
    signature::hazmat::PrehashSigner, Signature as P256Signature, SigningKey as P256SigningKey,
};
use sha2::{Digest, Sha256};
use soroban_sdk::{
    auth::{Context, ContractContext},
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

use crate::storage::{passkey_id, DataKey};
use crate::webauthn::Assertion;
use crate::{AccountError, ObsydAccount, ObsydAccountClient};

const RP_ID: &[u8] = b"obsyd.app";
const ORIGIN: &str = "https://obsyd.app";
// WebAuthn §6.1 flag bits, written out independently of webauthn.rs so a wrong
// constant there cannot be mirrored here and still pass.
const UP: u8 = 1 << 0;
const RFU1: u8 = 1 << 1;
const UV: u8 = 1 << 2;
const BACKUP_ELIGIBLE: u8 = 1 << 3;
const BACKED_UP: u8 = 1 << 4;
const ATTESTED: u8 = 1 << 6;

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// base64url without padding, mirroring what `navigator.credentials` puts in the
/// challenge field — and what the contract re-derives independently. 32 bytes
/// produce 43 characters.
fn b64url(input: &[u8]) -> String {
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0usize;
    while i < input.len() {
        let b0 = input[i] as u32;
        let has1 = i + 1 < input.len();
        let has2 = i + 2 < input.len();
        let b1 = if has1 { input[i + 1] as u32 } else { 0 };
        let b2 = if has2 { input[i + 2] as u32 } else { 0 };
        out.push(ALPHA[((b0 >> 2) & 0x3f) as usize] as char);
        out.push(ALPHA[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if has1 {
            out.push(ALPHA[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        }
        if has2 {
            out.push(ALPHA[(b2 & 0x3f) as usize] as char);
        }
        i += 3;
    }
    out
}

fn to_bytes(env: &Env, data: &[u8]) -> Bytes {
    let mut out = Bytes::new(env);
    for &byte in data {
        out.push_back(byte);
    }
    out
}

/// The contract error a `try_*` client call produced, panicking if it succeeded.
///
/// The generated clients follow one convention worth stating: `client.f(..)`
/// returns the success value and **traps** on a contract error, so asserting on
/// an error always goes through the `try_f(..)` twin, whose error arm is itself a
/// `Result<AccountError, InvokeError>`. The success arm stays generic because the
/// client wraps it in a further `Result`.
fn account_error<T>(
    got: Result<T, Result<AccountError, soroban_sdk::InvokeError>>,
) -> AccountError {
    got.err().expect("expected the call to fail").unwrap()
}

/// A P-256 key pair standing in for one authenticator.
struct Authenticator {
    key: P256SigningKey,
    public_key: [u8; 65],
}

impl Authenticator {
    fn new(seed: u8) -> Self {
        let key = P256SigningKey::from_bytes(&[seed; 32].into()).unwrap();
        let point = key.verifying_key().to_encoded_point(false);
        Self {
            key,
            public_key: point.as_bytes().try_into().unwrap(),
        }
    }

    fn public_key_bytesn(&self, env: &Env) -> BytesN<65> {
        BytesN::from_array(env, &self.public_key)
    }
}

/// The knobs a test may tamper with, all defaulted to a valid assertion.
struct Fixture {
    rp_id_hash: [u8; 32],
    flags: u8,
    ceremony_type: String,
    challenge: Option<String>,
    origin: String,
    nonce: u64,
}

impl Fixture {
    fn valid() -> Self {
        Self {
            rp_id_hash: sha256(&[RP_ID]),
            flags: UP | UV,
            ceremony_type: String::from("webauthn.get"),
            challenge: None,
            origin: String::from(ORIGIN),
            nonce: 0,
        }
    }
}

fn build_assertion(env: &Env, auth: &Authenticator, payload: &BytesN<32>, f: &Fixture) -> Val {
    let payload_arr = payload.to_array();
    let challenge = f
        .challenge
        .clone()
        .unwrap_or_else(|| b64url(&payload_arr));

    let client_data_json = format!(
        "{{\"type\":\"{}\",\"challenge\":\"{}\",\"origin\":\"{}\",\"crossOrigin\":false}}",
        f.ceremony_type, challenge, f.origin
    )
    .into_bytes();

    // Minimal CTAP2 authData for a `get` ceremony: rpIdHash || flags || counter.
    let mut auth_data: StdVec<u8> = vec![0u8; 37];
    auth_data[..32].copy_from_slice(&f.rp_id_hash);
    auth_data[32] = f.flags;
    auth_data[33..37].copy_from_slice(&1u32.to_be_bytes());

    let cd_hash = sha256(&[&client_data_json]);
    let digest = sha256(&[&auth_data, &cd_hash]);

    let sig: P256Signature = auth.key.sign_prehash(&digest).unwrap();
    // Soroban's secp256r1 verifier only accepts the low-s normalisation.
    let sig = sig.normalize_s().unwrap_or(sig);

    Assertion {
        public_key: auth.public_key_bytesn(env),
        auth_data: to_bytes(env, &auth_data),
        client_data_json: to_bytes(env, &client_data_json),
        signature: BytesN::from_array(env, &sig.to_bytes().into()),
        nonce: f.nonce,
    }
    .into_val(env)
}

fn session_signature(
    env: &Env,
    ed: &Ed25519SigningKey,
    id: &BytesN<32>,
    payload: &BytesN<32>,
    nonce: u64,
) -> Val {
    let sig = ed.sign(&payload.to_array());
    Vec::<Val>::from_array(
        env,
        [
            id.clone().into_val(env),
            BytesN::from_array(env, &sig.to_bytes()).into_val(env),
            nonce.into_val(env),
        ],
    )
    .into_val(env)
}

fn transfer_context(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) -> Context {
    let mut args = Vec::new(env);
    args.push_back(from.clone().into_val(env));
    args.push_back(to.clone().into_val(env));
    args.push_back(amount.into_val(env));
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(env, "transfer"),
        args,
    })
}

/// Deploy a wallet owned by a fresh credential, with the usual strict policy.
fn deploy(env: &Env) -> (Address, Authenticator) {
    env.mock_all_auths();
    let auth = Authenticator::new(42);
    let id = env.register(
        ObsydAccount,
        (
            auth.public_key_bytesn(env),
            BytesN::from_array(env, &sha256(&[RP_ID])),
            to_bytes(env, ORIGIN.as_bytes()),
            true,
            true,
            false,
        ),
    );
    (id, auth)
}

fn auth_result(
    env: &Env,
    wallet: &Address,
    payload: &BytesN<32>,
    signature: &Val,
    contexts: &Vec<Context>,
) -> Result<(), Result<AccountError, soroban_sdk::InvokeError>> {
    env.try_invoke_contract_check_auth::<AccountError>(wallet, payload, *signature, contexts)
}

fn no_contexts(env: &Env) -> Vec<Context> {
    Vec::new(env)
}

/// Assert a check_auth call failed with exactly this contract error.
fn assert_auth_err(env: &Env, wallet: &Address, payload: &BytesN<32>, signature: &Val, expected: AccountError) {
    let got = auth_result(env, wallet, payload, signature, &no_contexts(env));
    match got {
        Err(Ok(e)) if e == expected => {}
        other => panic!("expected {:?}, got {:?}", expected, other),
    }
}

// ── construction ─────────────────────────────────────────────────────────────

#[test]
fn constructor_registers_owner_and_policy() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);

    assert!(client.initialized());
    let keys = client.get_passkeys();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys.get_unchecked(0), auth.public_key_bytesn(&env));

    let policy = client.get_policy().unwrap();
    assert_eq!(policy.rp_id_hash, BytesN::from_array(&env, &sha256(&[RP_ID])));
    assert!(policy.require_user_presence);
    assert!(policy.require_user_verification);
    assert!(!policy.allow_backup_eligible);
    assert_eq!(client.version(), 1);
}

// ── happy path ───────────────────────────────────────────────────────────────

#[test]
fn valid_passkey_assertion_authorizes_and_advances_nonce() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let payload = BytesN::from_array(&env, &[7u8; 32]);

    let sig = build_assertion(&env, &auth, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &no_contexts(&env)).expect("valid assertion");
    assert_eq!(client.passkey_nonce(&auth.public_key_bytesn(&env)), 1);
}

#[test]
fn owner_can_authorize_a_token_transfer() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let token = Address::generate(&env);
    let to = Address::generate(&env);
    let contexts = Vec::from_array(
        &env,
        [transfer_context(&env, &token, &wallet, &to, 1_000i128)],
    );

    let sig = build_assertion(&env, &auth, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &contexts).expect("owner is unrestricted");
}

#[test]
fn a_second_registered_passkey_can_authorize() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let second = Authenticator::new(99);
    let _ = client.add_passkey(&second.public_key_bytesn(&env), &Symbol::new(&env, "laptop"));
    assert_eq!(client.get_passkeys().len(), 2);

    let payload = BytesN::from_array(&env, &[3u8; 32]);
    let sig = build_assertion(&env, &second, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &no_contexts(&env)).expect("second key works");
}

// ── replay ───────────────────────────────────────────────────────────────────

#[test]
fn the_same_assertion_cannot_be_replayed() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let f = Fixture::valid();

    let first = build_assertion(&env, &auth, &payload, &f);
    auth_result(&env, &wallet, &payload, &first, &no_contexts(&env)).expect("first use");

    // Same nonce, counter already moved on.
    let again = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &again, AccountError::NonceMismatch);
}

// ── WebAuthn binding ─────────────────────────────────────────────────────────

#[test]
fn an_unregistered_passkey_is_rejected() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let stranger = Authenticator::new(11);
    let sig = build_assertion(&env, &stranger, &payload, &Fixture::valid());
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::UnknownPasskey);
}

#[test]
fn an_assertion_for_another_relying_party_is_rejected() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.rp_id_hash = sha256(&[b"evil.example"]);
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::WrongRpId);
}

#[test]
fn an_assertion_for_another_transaction_is_rejected() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    // The challenge commits to the host auth payload, so an assertion collected
    // for a different payload cannot authorize this one.
    let other = BytesN::from_array(&env, &[9u8; 32]);
    let sig = build_assertion(&env, &auth, &other, &Fixture::valid());
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::ChallengeMismatch);
}

#[test]
fn a_registration_ceremony_is_rejected() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.ceremony_type = String::from("webauthn.create");
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::BadClientData);
}

#[test]
fn a_pinned_origin_must_match() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.origin = String::from("https://phishing.example");
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::BadOrigin);
}

#[test]
fn user_presence_is_required() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.flags = UV;
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::UserPresenceRequired);
}

#[test]
fn user_verification_is_required_when_policy_says_so() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.flags = UP;
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::UserVerificationRequired);
}

#[test]
fn the_reserved_bit_is_not_user_verification() {
    // A real authenticator never sets bit 1; it must not satisfy a UV policy.
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.flags = UP | RFU1;
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::UserVerificationRequired);
}

#[test]
fn a_backed_up_credential_is_rejected_by_default() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.flags = UP | UV | BACKUP_ELIGIBLE | BACKED_UP;
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::BackupKeyNotAllowed);
}

#[test]
fn a_cloud_synced_credential_is_rejected_by_default() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.flags = UP | UV | BACKUP_ELIGIBLE;
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::BackupKeyNotAllowed);
}

#[test]
fn a_policy_can_admit_synced_credentials() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let _ = client.set_policy(
        &BytesN::from_array(&env, &sha256(&[RP_ID])),
        &to_bytes(&env, ORIGIN.as_bytes()),
        &true,
        &true,
        &true,
    );
    assert!(client.get_policy().unwrap().allow_backup_eligible);

    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.flags = UP | UV | BACKUP_ELIGIBLE;
    let sig = build_assertion(&env, &auth, &payload, &f);
    auth_result(&env, &wallet, &payload, &sig, &no_contexts(&env)).expect("policy allows it");
}

#[test]
fn an_attested_ceremony_is_rejected() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let mut f = Fixture::valid();
    f.flags = UP | UV | ATTESTED;
    let sig = build_assertion(&env, &auth, &payload, &f);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::AuthDataAttested);
}

#[test]
fn truncated_auth_data_is_rejected() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let payload = BytesN::from_array(&env, &[7u8; 32]);
    let sig = Assertion {
        public_key: auth.public_key_bytesn(&env),
        auth_data: to_bytes(&env, &[0u8; 10]),
        client_data_json: to_bytes(&env, b"{}"),
        signature: BytesN::from_array(&env, &[0u8; 64]),
        nonce: 0,
    }
    .into_val(&env);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::AuthDataTooShort);
}

// ── signer management ────────────────────────────────────────────────────────

#[test]
fn the_last_passkey_cannot_be_removed() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let err = client.try_remove_passkey(&auth.public_key_bytesn(&env));
    assert_eq!(account_error(err), AccountError::LastPasskey);
    assert_eq!(client.get_passkeys().len(), 1);
}

#[test]
fn rotating_the_key_keeps_the_address_and_drops_leases() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);

    let ed = Ed25519SigningKey::from_bytes(&[3u8; 32]);
    let _ = client.elevate_session(
        &BytesN::from_array(&env, &ed.verifying_key().to_bytes()),
        &Symbol::new(&env, "daily"),
        &3600u64,
    );
    assert_eq!(client.get_sessions().len(), 1);

    let next = Authenticator::new(77);
    let _ = client.rotate_passkey(
        &auth.public_key_bytesn(&env),
        &next.public_key_bytesn(&env),
        &Symbol::new(&env, "newdevice"),
    );

    let keys = client.get_passkeys();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys.get_unchecked(0), next.public_key_bytesn(&env));
    assert_eq!(client.get_sessions().len(), 0);

    // The new credential works, the old one is gone.
    let payload = BytesN::from_array(&env, &[5u8; 32]);
    let sig = build_assertion(&env, &next, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &no_contexts(&env)).expect("rotated key authorizes");
}

#[test]
fn a_duplicate_passkey_is_rejected() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let err = client.try_add_passkey(&auth.public_key_bytesn(&env), &Symbol::new(&env, "dupe"));
    assert_eq!(account_error(err), AccountError::PasskeyExists);
}

// ── session keys ─────────────────────────────────────────────────────────────

fn elevate(env: &Env, client: &ObsydAccountClient, ed: &Ed25519SigningKey) -> BytesN<32> {
    let vk = ed.verifying_key().to_bytes();
    let _ = client.elevate_session(
        &BytesN::from_array(env, &vk),
        &Symbol::new(env, "daily"),
        &3600u64,
    );
    BytesN::from_array(env, &sha256(&[&vk]))
}

#[test]
fn an_elevated_session_key_authorizes_ordinary_calls() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let ed = Ed25519SigningKey::from_bytes(&[3u8; 32]);
    let id = elevate(&env, &client, &ed);
    assert!(client.get_session(&id).is_some());

    let payload = BytesN::from_array(&env, &[11u8; 32]);
    let token = Address::generate(&env);
    let contexts = Vec::from_array(
        &env,
        [transfer_context(&env, &token, &wallet, &Address::generate(&env), 50i128)],
    );
    let sig = session_signature(&env, &ed, &id, &payload, 0);
    auth_result(&env, &wallet, &payload, &sig, &contexts).expect("session key works");
    assert_eq!(client.session_nonce(&id), 1);
}

#[test]
fn a_session_key_cannot_touch_any_admin_function() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let ed = Ed25519SigningKey::from_bytes(&[4u8; 32]);
    let id = elevate(&env, &client, &ed);

    // Every entry point that can change who controls the wallet, including
    // `execute`, which would otherwise let a stolen lease batch its way past
    // this list, and `begin_recovery`, which it could use to jam recovery.
    const FORBIDDEN: [&str; 17] = [
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

    let payload = BytesN::from_array(&env, &[12u8; 32]);
    let sig = session_signature(&env, &ed, &id, &payload, 0);
    for name in FORBIDDEN {
        let ctx = Context::Contract(ContractContext {
            contract: wallet.clone(),
            fn_name: Symbol::new(&env, name),
            args: Vec::new(&env),
        });
        let contexts = Vec::from_array(&env, [ctx]);
        let got = auth_result(&env, &wallet, &payload, &sig, &contexts);
        match got {
            Err(Ok(AccountError::ForbiddenForSession)) => {}
            other => panic!("{name}: expected ForbiddenForSession, got {:?}", other),
        }
    }
    // Rejected authorisations must not burn the lease's counter.
    assert_eq!(client.session_nonce(&id), 0);
}

#[test]
fn an_expired_session_key_is_rejected() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let ed = Ed25519SigningKey::from_bytes(&[5u8; 32]);
    let id = elevate(&env, &client, &ed);

    let start = env.ledger().timestamp();
    env.ledger().set_timestamp(start + 3600);

    let payload = BytesN::from_array(&env, &[13u8; 32]);
    let sig = session_signature(&env, &ed, &id, &payload, 0);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::SessionExpired);
}

#[test]
fn an_unknown_session_id_is_rejected() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let ed = Ed25519SigningKey::from_bytes(&[6u8; 32]);
    let payload = BytesN::from_array(&env, &[14u8; 32]);
    let sig = session_signature(
        &env,
        &ed,
        &BytesN::from_array(&env, &[0u8; 32]),
        &payload,
        0,
    );
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::SessionUnknown);
}

#[test]
fn a_session_can_be_revoked() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let ed = Ed25519SigningKey::from_bytes(&[8u8; 32]);
    let id = elevate(&env, &client, &ed);
    let _ = client.revoke_session(&id);
    assert!(client.get_session(&id).is_none());

    let payload = BytesN::from_array(&env, &[15u8; 32]);
    let sig = session_signature(&env, &ed, &id, &payload, 0);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::SessionUnknown);
}

#[test]
fn an_overlong_session_lease_is_refused() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let ed = Ed25519SigningKey::from_bytes(&[9u8; 32]);
    let err = client.try_elevate_session(
        &BytesN::from_array(&env, &ed.verifying_key().to_bytes()),
        &Symbol::new(&env, "forever"),
        &(30 * 24 * 60 * 60u64),
    );
    assert_eq!(account_error(err), AccountError::BadArgs);
}

// ── spend limits ─────────────────────────────────────────────────────────────

#[test]
fn a_spend_limit_caps_session_transfers() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let ed = Ed25519SigningKey::from_bytes(&[10u8; 32]);
    let id = elevate(&env, &client, &ed);
    let token = Address::generate(&env);
    let _ = client.set_spend_limit(&token, &100i128, &3600u64);

    // Over the cap.
    let payload = BytesN::from_array(&env, &[16u8; 32]);
    let contexts = Vec::from_array(
        &env,
        [transfer_context(&env, &token, &wallet, &Address::generate(&env), 250i128)],
    );
    let sig = session_signature(&env, &ed, &id, &payload, 0);
    let got = auth_result(&env, &wallet, &payload, &sig, &contexts);
    match got {
        Err(Ok(AccountError::SpendLimitExceeded)) => {}
        other => panic!("expected SpendLimitExceeded, got {:?}", other),
    }
    assert_eq!(client.session_nonce(&id), 0, "rejected auth leaves no trace");

    // Under the cap: charged to the window.
    let payload2 = BytesN::from_array(&env, &[17u8; 32]);
    let contexts2 = Vec::from_array(
        &env,
        [transfer_context(&env, &token, &wallet, &Address::generate(&env), 40i128)],
    );
    let sig2 = session_signature(&env, &ed, &id, &payload2, 0);
    auth_result(&env, &wallet, &payload2, &sig2, &contexts2).expect("within cap");
    assert_eq!(client.get_spend_limit(&token).unwrap().spent, 40i128);
}

#[test]
fn a_passkey_is_exempt_from_spend_limits() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let token = Address::generate(&env);
    let _ = client.set_spend_limit(&token, &1i128, &3600u64);

    let payload = BytesN::from_array(&env, &[18u8; 32]);
    let contexts = Vec::from_array(
        &env,
        [transfer_context(&env, &token, &wallet, &Address::generate(&env), 999i128)],
    );
    let sig = build_assertion(&env, &auth, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &contexts).expect("owner is not capped");
}

// ── durability ───────────────────────────────────────────────────────────────

/// Remaining ledgers before the host drops a persistent entry.
///
/// `get_ttl` is a test-only view of the ledger's own bookkeeping, so this asserts
/// the renewal itself rather than hoping eviction happens to be simulated.
fn ttl(env: &Env, wallet: &Address, key: &DataKey) -> u32 {
    use soroban_sdk::testutils::storage::Persistent as _;
    env.as_contract(wallet, || env.storage().persistent().get_ttl(key))
}

/// The window `storage.rs` promises to keep state alive for.
const WINDOW: u32 = 40_000;

/// `__check_auth` reads the whole security set and writes only a nonce, and only
/// writes extend a lifetime. Without the refresh on the auth path the signer set,
/// the policy, the spend caps and the recovery configuration would lapse a window
/// after deployment — the wallet would stop recognising its own passkeys, an
/// configured cap would silently become *no* cap, and no call can put them back.
#[test]
fn a_passkey_authorization_renews_the_state_it_read() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);

    let backup = Authenticator::new(44);
    let backup_pk = backup.public_key_bytesn(&env);
    let _ = client.add_passkey(&backup_pk, &Symbol::new(&env, "laptop"));
    let token = Address::generate(&env);
    let _ = client.set_spend_limit(&token, &100i128, &3600u64);
    let guardian = Address::generate(&env);
    configure_recovery(&client, &[guardian.clone()], 1);

    // Age the wallet into the last stretch of its window.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + WINDOW - 1_000);
    assert!(
        ttl(&env, &wallet, &DataKey::Policy) < 2_000,
        "the state should be close to lapsing before the authorization"
    );

    let payload = BytesN::from_array(&env, &[19u8; 32]);
    let sig = build_assertion(&env, &auth, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &no_contexts(&env)).expect("owner authorizes");

    let cases = [
        ("initialization", DataKey::Initialized),
        ("policy", DataKey::Policy),
        ("passkey list", DataKey::PasskeyIds),
        ("second passkey", DataKey::Passkey(passkey_id(&env, &backup_pk))),
        ("spend cap", DataKey::Limit(token.clone())),
        ("cap index", DataKey::LimitTokens),
        ("recovery params", DataKey::RecoveryParams),
        ("guardian list", DataKey::Guardians),
        ("guardian", DataKey::Guardian(guardian)),
    ];
    for (name, key) in cases {
        let left = ttl(&env, &wallet, &key);
        assert!(left >= WINDOW - 100, "{name} lapsed instead of renewing: {left}");
    }

    // The credential that signed, the session index and the instance too.
    assert!(client.initialized());
    assert_eq!(client.get_passkeys().len(), 2);
    assert_eq!(client.get_spend_limit(&token).unwrap().amount, 100i128);
}

/// A lease can outlive one window — `MAX_SESSION_TTL` is 7 days, which is more
/// ledgers than 40,000 at testnet pace — so a period of session-only activity
/// must not cost the owner the passkeys that outrank the lease.
#[test]
fn a_session_authorization_renews_the_owner_state() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);

    let ed = Ed25519SigningKey::from_bytes(&[5u8; 32]);
    let vk = ed.verifying_key().to_bytes();
    let _ = client.elevate_session(
        &BytesN::from_array(&env, &vk),
        &Symbol::new(&env, "week"),
        &604_800u64,
    );
    let id = BytesN::from_array(&env, &sha256(&[&vk]));
    let token = Address::generate(&env);
    let _ = client.set_spend_limit(&token, &100i128, &3600u64);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + WINDOW - 1_000);

    let payload = BytesN::from_array(&env, &[20u8; 32]);
    let contexts = Vec::from_array(
        &env,
        [transfer_context(
            &env,
            &token,
            &wallet,
            &Address::generate(&env),
            40i128,
        )],
    );
    let sig = session_signature(&env, &ed, &id, &payload, 0);
    auth_result(&env, &wallet, &payload, &sig, &contexts).expect("lease authorizes");

    let owner_pk = client.get_passkeys().get_unchecked(0);
    let cases = [
        ("passkey", DataKey::Passkey(passkey_id(&env, &owner_pk))),
        ("passkey list", DataKey::PasskeyIds),
        ("policy", DataKey::Policy),
        ("spend cap", DataKey::Limit(token.clone())),
        ("lease", DataKey::Session(id.clone())),
    ];
    for (name, key) in cases {
        let left = ttl(&env, &wallet, &key);
        assert!(left >= WINDOW - 100, "{name} lapsed instead of renewing: {left}");
    }

    // The lease is still only a lease: the cap charged above stands.
    assert_eq!(
        client.get_spend_limit(&token).unwrap().spent,
        40i128,
        "and the charge landed"
    );
}

// ── guardian recovery ────────────────────────────────────────────────────────

fn configure_recovery(client: &ObsydAccountClient, guardians: &[Address], threshold: u32) {
    for g in guardians {
        let _ = client.add_guardian(g);
    }
    let _ = client.set_recovery(&threshold, &3600u64);
}

#[test]
fn guardian_quorum_recovers_the_wallet_after_the_timelock() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let g1 = Address::generate(&env);
    let g2 = Address::generate(&env);
    configure_recovery(&client, &[g1.clone(), g2.clone()], 2);

    let fresh = Authenticator::new(123);
    let _ = client.begin_recovery(&fresh.public_key_bytesn(&env));
    assert!(client.get_pending_recovery().is_some());

    // Still inside the timelock: nothing moves.
    let signers = Vec::from_array(&env, [g1.clone(), g2.clone()]);
    let err = client.try_execute_recovery(&signers);
    assert_eq!(account_error(err), AccountError::TimelockNotElapsed);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    let recovered = client.execute_recovery(&signers);
    assert_eq!(recovered, fresh.public_key_bytesn(&env));
    assert!(client.get_pending_recovery().is_none());
    assert_eq!(client.get_passkeys().len(), 1);
    assert_eq!(client.get_passkeys().get_unchecked(0), fresh.public_key_bytesn(&env));

    // The new credential can authorize; the wallet address never changed.
    let payload = BytesN::from_array(&env, &[19u8; 32]);
    let sig = build_assertion(&env, &fresh, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &no_contexts(&env)).expect("recovered key works");
}

#[test]
fn recovery_refuses_a_short_quorum() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let g1 = Address::generate(&env);
    let g2 = Address::generate(&env);
    configure_recovery(&client, &[g1.clone(), g2.clone()], 2);

    let fresh = Authenticator::new(124);
    let _ = client.begin_recovery(&fresh.public_key_bytesn(&env));
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    let only_one = Vec::from_array(&env, [g1.clone()]);
    assert_eq!(
        account_error(client.try_execute_recovery(&only_one)),
        AccountError::QuorumNotMet
    );
    assert_eq!(client.get_passkeys().len(), 1);
}

#[test]
fn a_non_guardian_cannot_be_counted_towards_recovery() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let g1 = Address::generate(&env);
    configure_recovery(&client, &[g1.clone()], 1);

    let fresh = Authenticator::new(125);
    let _ = client.begin_recovery(&fresh.public_key_bytesn(&env));
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    let attacker = Address::generate(&env);
    let signers = Vec::from_array(&env, [attacker]);
    assert_eq!(
        account_error(client.try_execute_recovery(&signers)),
        AccountError::NotAGuardian
    );
}

#[test]
fn a_guardian_cannot_be_listed_twice_to_meet_quorum() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let g1 = Address::generate(&env);
    configure_recovery(&client, &[g1.clone()], 1);

    let fresh = Authenticator::new(126);
    let _ = client.begin_recovery(&fresh.public_key_bytesn(&env));
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    let signers = Vec::from_array(&env, [g1.clone(), g1.clone()]);
    assert_eq!(
        account_error(client.try_execute_recovery(&signers)),
        AccountError::DuplicateGuardian
    );
}

#[test]
fn recovery_needs_no_owner_authorization_but_configuration_does() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    // No guardians or quorum configured yet: a recovery attempt is refused rather
    // than left to hang.
    assert_eq!(
        account_error(
            client.try_begin_recovery(&Authenticator::new(127).public_key_bytesn(&env))
        ),
        AccountError::NoGuardians
    );
}

#[test]
fn the_owner_can_cancel_a_pending_recovery() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    let g1 = Address::generate(&env);
    configure_recovery(&client, &[g1.clone()], 1);

    let fresh = Authenticator::new(128);
    let _ = client.begin_recovery(&fresh.public_key_bytesn(&env));
    let _ = client.cancel_recovery();
    assert!(client.get_pending_recovery().is_none());
}

// ── misc ─────────────────────────────────────────────────────────────────────

#[test]
fn an_unparseable_signature_is_rejected() {
    let env = Env::default();
    let (wallet, _) = deploy(&env);
    let payload = BytesN::from_array(&env, &[20u8; 32]);
    let sig = 42u64.into_val(&env);
    assert_auth_err(&env, &wallet, &payload, &sig, AccountError::InvalidSignature);
}

#[test]
fn a_live_wallet_cannot_be_re_initialized_by_anyone_else() {
    let env = Env::default();
    let (wallet, auth) = deploy(&env);
    let client = ObsydAccountClient::new(&env, &wallet);
    assert!(client.initialized());

    // The whole front-running story depends on this: `__constructor` is only
    // reachable from the host at deploy time, so no caller can re-point a live
    // wallet (and its balances) at a credential they control.
    let attacker = Authenticator::new(43);
    let args = Vec::from_array(
        &env,
        [
            attacker.public_key_bytesn(&env).into_val(&env),
            BytesN::from_array(&env, &sha256(&[RP_ID])).into_val(&env),
            to_bytes(&env, ORIGIN.as_bytes()).into_val(&env),
            true.into_val(&env),
            true.into_val(&env),
            false.into_val(&env),
        ],
    );
    let outcome =
        env.try_invoke_contract::<(), AccountError>(&wallet, &Symbol::new(&env, "__constructor"), args);
    assert!(
        matches!(outcome, Err(Err(_))),
        "the host must refuse a direct call to the reserved constructor"
    );

    // Nothing moved: the owner set at deployment still controls the wallet.
    assert_eq!(client.get_passkeys().len(), 1);
    assert_eq!(
        client.get_passkeys().get_unchecked(0),
        auth.public_key_bytesn(&env)
    );
    let payload = BytesN::from_array(&env, &[21u8; 32]);
    let sig = build_assertion(&env, &auth, &payload, &Fixture::valid());
    auth_result(&env, &wallet, &payload, &sig, &no_contexts(&env))
        .expect("the original owner still authorizes");
}

#[test]
fn the_challenge_encoder_agrees_with_the_webauthn_shape() {
    // 32 bytes must encode to 43 unpadded base64url characters, which is what a
    // browser reports for a 32-byte challenge.
    assert_eq!(b64url(&[7u8; 32]).len(), 43);
    assert_eq!(b64url(&[0u8; 32]).len(), 43);
    assert!(!b64url(&[0xffu8; 32]).contains('='));
}
