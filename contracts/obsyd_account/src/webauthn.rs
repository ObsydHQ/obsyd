//! WebAuthn (ES256 / NIST P-256) assertion verification, entirely on-chain.
//!
//! A passkey does not sign the Stellar transaction — it signs the *challenge*
//! the WebAuthn protocol puts in `clientDataJSON`. The Soroban host hands
//! `__check_auth` a 32-byte `signature_payload` that commits to the exact
//! invocation being authorized, so the flow is:
//!
//! 1. the wallet asks the authenticator to sign `base64url(signature_payload)`;
//! 2. the raw assertion (`authenticatorData`, `clientDataJSON`, ECDSA signature)
//!    travels inside the transaction's `SorobanAuthorizationEntry` signature;
//! 3. this module re-derives the message the authenticator actually signed and
//!    checks it against the registered credential with the `secp256r1` precompile.
//!
//! Signature format follows CTAP2/WebAuthn:
//!
//! ```text
//! authData = rpIdHash(32) || flags(1) || counter(4) [|| attestedCredentialData] [|| exts]
//! signed   = authData || sha256(clientDataJSON)
//! digest   = sha256(signed)
//! ```
//!
//! Nothing here can be faked offline: a wrong RP id, a `start`/`payment` ceremony
//! instead of `webauthn.get`, a challenge from another transaction, a missing
//! user-presence flag or an out-of-band ECDSA signature all fail closed.

use soroban_sdk::{contracttype, Bytes, BytesN, Env};

use crate::storage::Policy;
use crate::AccountError;

/// Authenticator data flags (CTAP2, byte 32 of authData).
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x02;
const FLAG_BE: u8 = 0x04;
const FLAG_BS: u8 = 0x08;
const FLAG_AT: u8 = 0x40;

/// Minimum authData length: rpIdHash + flags + counter.
const AUTH_DATA_MIN: u32 = 37;

const BASE64URL: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// The credential assertion the client presents as its "signature" value.
#[contracttype]
#[derive(Clone)]
pub struct Assertion {
    /// SEC1 uncompressed point (0x04 || X || Y) of the passkey that signed.
    pub public_key: BytesN<65>,
    /// Raw `credentialResponse.response.authenticatorData`.
    pub auth_data: Bytes,
    /// Raw `credentialResponse.response.clientDataJSON`.
    pub client_data_json: Bytes,
    /// ES256 signature as raw `r || s` (64 bytes, no DER wrapper).
    pub signature: BytesN<64>,
    /// The wallet's own replay counter for this credential.
    pub nonce: u64,
}

fn flag(flags: u8, bit: u8) -> bool {
    flags & bit != 0
}

/// Structural equality for two `Bytes` values.
fn eq_bytes(a: &Bytes, b: &Bytes) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0u32;
    while i < a.len() {
        if a.get_unchecked(i) != b.get_unchecked(i) {
            return false;
        }
        i += 1;
    }
    true
}

/// base64url (unpadded) of a 32-byte value, exactly how the browser encodes the
/// WebAuthn challenge inside clientDataJSON. 32 bytes → 43 characters.
pub fn base64url_32(env: &Env, input: &BytesN<32>) -> Bytes {
    let arr = input.to_array();
    let mut out = Bytes::new(env);
    let mut i = 0usize;
    while i < 32 {
        let b0 = arr[i] as u32;
        out.push_back(BASE64URL[((b0 >> 2) & 0x3f) as usize]);
        if i + 1 < 32 {
            let b1 = arr[i + 1] as u32;
            out.push_back(BASE64URL[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize]);
            if i + 2 < 32 {
                let b2 = arr[i + 2] as u32;
                out.push_back(BASE64URL[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize]);
                out.push_back(BASE64URL[(b2 & 0x3f) as usize]);
                i += 3;
            } else {
                out.push_back(BASE64URL[((b1 & 0x0f) << 2) as usize]);
                i += 2;
            }
        } else {
            out.push_back(BASE64URL[((b0 & 0x03) << 4) as usize]);
            i += 1;
        }
    }
    out
}

/// First index at which `needle` occurs in `hay` at or after `from`.
fn index_of(hay: &Bytes, needle: &Bytes, from: u32) -> Option<u32> {
    let h = hay.len();
    let n = needle.len();
    if n == 0 || h < n {
        return None;
    }
    let mut start = from;
    while start + n <= h {
        let mut j = 0u32;
        while j < n {
            if hay.get_unchecked(start + j) != needle.get_unchecked(j) {
                break;
            }
            j += 1;
        }
        if j == n {
            return Some(start);
        }
        start += 1;
    }
    None
}

fn skip_ws(hay: &Bytes, mut i: u32) -> u32 {
    while i < hay.len() {
        match hay.get_unchecked(i) {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            _ => break,
        }
    }
    i
}

/// Read the value of a top-level JSON string key.
///
/// `type`, `challenge` and `origin` are plain strings with no escapes, so the
/// closing-quote scan is sufficient. The lookup is position-aware (`"key":`), so
/// the same word appearing as a nested value cannot be mistaken for the key.
fn json_string(env: &Env, hay: &Bytes, key: &[u8]) -> Option<Bytes> {
    let mut quoted = Bytes::from_array(env, b"\"");
    quoted.extend_from_slice(key);
    quoted.extend_from_array(b"\"");

    let mut from = 0u32;
    loop {
        let at = index_of(hay, &quoted, from)?;
        let mut i = skip_ws(hay, at + quoted.len());
        if i >= hay.len() || hay.get_unchecked(i) != b':' {
            from = at + 1;
            continue;
        }
        i = skip_ws(hay, i + 1);
        if i >= hay.len() || hay.get_unchecked(i) != b'"' {
            from = at + 1;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        while j < hay.len() && hay.get_unchecked(j) != b'"' {
            j += 1;
        }
        if j >= hay.len() {
            return None;
        }
        return Some(hay.slice(start..j));
    }
}

/// Verify an assertion against the wallet policy and the host-supplied payload.
///
/// Returns the authData counter. ECDSA verification *traps* the host on failure
/// rather than returning an error, so this only reaches `Ok` for a signature
/// that really verified; the trap aborts the whole transaction.
pub fn verify(
    env: &Env,
    assertion: &Assertion,
    payload: &BytesN<32>,
    policy: &Policy,
) -> Result<u32, AccountError> {
    let pk = Bytes::from(assertion.public_key.clone());
    if pk.len() != 65 || pk.get_unchecked(0) != 0x04 {
        return Err(AccountError::BadPublicKey);
    }

    let ad = &assertion.auth_data;
    if ad.len() < AUTH_DATA_MIN {
        return Err(AccountError::AuthDataTooShort);
    }

    // 1. Relying-party binding: authData[0..32] is sha256(rpId).
    if !eq_bytes(&ad.slice(0..32), &Bytes::from(policy.rp_id_hash.clone())) {
        return Err(AccountError::WrongRpId);
    }

    // 2. Flag policy.
    let flags = ad.get_unchecked(32);
    if policy.require_user_presence && !flag(flags, FLAG_UP) {
        return Err(AccountError::UserPresenceRequired);
    }
    if policy.require_user_verification && !flag(flags, FLAG_UV) {
        return Err(AccountError::UserVerificationRequired);
    }
    if !policy.allow_backup_eligible && (flag(flags, FLAG_BE) || flag(flags, FLAG_BS)) {
        return Err(AccountError::BackupKeyNotAllowed);
    }
    // A `get` ceremony never carries attested credential data.
    if flag(flags, FLAG_AT) {
        return Err(AccountError::AuthDataAttested);
    }

    // 3. The ceremony must be an assertion for this dapp.
    let cd = &assertion.client_data_json;
    let ty = json_string(env, cd, b"type").ok_or(AccountError::BadClientData)?;
    if !eq_bytes(&ty, &Bytes::from_array(env, b"webauthn.get")) {
        return Err(AccountError::BadClientData);
    }

    // 4. The challenge must be this exact Soroban auth payload.
    let challenge = json_string(env, cd, b"challenge").ok_or(AccountError::BadClientData)?;
    if !eq_bytes(&challenge, &base64url_32(env, payload)) {
        return Err(AccountError::ChallengeMismatch);
    }

    // 5. Origin, when the wallet pins one.
    if policy.origin.len() > 0 {
        let origin = json_string(env, cd, b"origin").ok_or(AccountError::BadClientData)?;
        if !eq_bytes(&origin, &policy.origin) {
            return Err(AccountError::BadOrigin);
        }
    }

    // 6. Reconstruct the message the authenticator signed, then verify it.
    let client_data_hash = env.crypto().sha256(cd);
    let mut signed = ad.clone();
    signed.extend_from_array(&client_data_hash.to_array());
    let digest = env.crypto().sha256(&signed);
    env.crypto()
        .secp256r1_verify(&assertion.public_key, &digest, &assertion.signature);

    // authData counter, big-endian u32 at [33..37]. Exposed for auditing; not
    // enforced as strictly monotonic because authenticators may clamp it and the
    // per-credential nonce above already prevents replay.
    let mut c = [0u8; 4];
    ad.slice(33..37).copy_into_slice(&mut c);
    Ok(((c[0] as u32) << 24) | ((c[1] as u32) << 16) | ((c[2] as u32) << 8) | (c[3] as u32))
}
