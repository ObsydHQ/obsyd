// Obsyd — passkey identity layer (client-only, original).
// Registers a real WebAuthn credential, extracts its P-256 public key, and derives
// a deterministic wallet identity from that key. No on-chain signing here (that is
// the deferred phase 5c contract work) — this file establishes the key + identity.

const ID_KEY = "obsyd.identity";
const CRED_KEY = "obsyd.passkey.id";
const PUB_KEY = "obsyd.passkey.pub"; // hex 0x04||X||Y

export type RegisteredPasskey = {
  credentialId: string; // base64url of rawId
  publicKeyHex: string; // 0x04 || X || Y  (130 hex chars)
  identity: string; // deterministic obsyd_… identifier
  x: string;
  y: string;
};

const isBrowser = () => typeof window !== "undefined" && "crypto" in window;

// ── base64url ─────────────────────────────────────────────────────────────
export function toB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(str: string): Uint8Array {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer));

// ── minimal CBOR reader (enough to parse a COSE EC2 public key map) ────────
function cborDecode(buf: Uint8Array): any {
  let pos = 0;
  const read = (n: number) => {
    const v = buf.slice(pos, pos + n);
    pos += n;
    return v;
  };
  const readHeader = (): { major: number; arg: number } => {
    const first = buf[pos++];
    const major = first >> 5;
    let ai = first & 0x1f;
    let arg: number;
    if (ai < 24) arg = ai;
    else if (ai === 24) arg = buf[pos++];
    else if (ai === 25) { arg = (buf[pos] << 8) | buf[pos + 1]; pos += 2; }
    else if (ai === 26) { arg = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; pos += 4; }
    else throw new Error("cbor: unsupported header size " + ai);
    return { major, arg };
  };
  const decode = (): any => {
    const { major, arg } = readHeader();
    switch (major) {
      case 0: return arg; // unsigned int
      case 1: return -1 - arg; // negative int
      case 2: return read(arg); // byte string
      case 3: { const b = read(arg); return new TextDecoder().decode(b); } // text
      case 4: { const arr: any[] = []; for (let i = 0; i < arg; i++) arr.push(decode()); return arr; }
      case 5: { const map = new Map<any, any>(); for (let i = 0; i < arg; i++) { const k = decode(); const v = decode(); map.set(k, v); } return map; }
      case 6: return decode(); // tag: unwrap
      default: throw new Error("cbor: bad major " + major);
    }
  };
  return decode();
}

/** Parse COSE EC2 (P-256) public key → { x, y, raw65 }. */
export function coseToP256(cose: Uint8Array): { x: Uint8Array; y: Uint8Array; raw: Uint8Array } {
  const map = cborDecode(cose) as Map<number, any>;
  const kty = map.get(1);
  const crv = map.get(-1);
  const x = map.get(-2) as Uint8Array;
  const y = map.get(-3) as Uint8Array;
  if (kty !== 2 || crv !== 1) throw new Error("not a P-256 EC2 key");
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 1 + x.length);
  return { x, y, raw };
}

/** Deterministic identity from a passkey public key. */
export async function deriveIdentity(publicKeyRaw: Uint8Array): Promise<string> {
  const h = await sha256(publicKeyRaw);
  return "obsyd_" + toHex(h.slice(0, 20));
}

// ── WebAuthn register (genuine credential in the browser authenticator) ────
export async function registerPasskey(rpId?: string, displayName = "Obsyd user"): Promise<RegisteredPasskey> {
  if (!isBrowser() || !("credentials" in navigator)) throw new Error("WebAuthn unavailable");
  const id = rpId || location.hostname;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Obsyd", id },
      user: { id: userId, name: displayName, displayName },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256 / P-256
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
      timeout: 60000,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("registration cancelled");

  const response = cred.response as AuthenticatorAttestationResponse;
  const cose = response.getPublicKey?.();
  if (!cose) throw new Error("authenticator did not expose a public key");
  const { x, y, raw } = coseToP256(new Uint8Array(cose));
  const credentialId = toB64url(cred.rawId);
  const identity = await deriveIdentity(raw);
  const rec: RegisteredPasskey = {
    credentialId,
    publicKeyHex: toHex(raw),
    identity,
    x: toHex(x),
    y: toHex(y),
  };
  if (isBrowser()) {
    localStorage.setItem(CRED_KEY, credentialId);
    localStorage.setItem(PUB_KEY, rec.publicKeyHex);
    localStorage.setItem(ID_KEY, identity);
  }
  return rec;
}

export function loadIdentity(): { identity: string; publicKeyHex?: string; credentialId?: string } | null {
  if (!isBrowser()) return null;
  const identity = localStorage.getItem(ID_KEY);
  if (!identity) return null;
  return { identity, publicKeyHex: localStorage.getItem(PUB_KEY) || undefined, credentialId: localStorage.getItem(CRED_KEY) || undefined };
}

export function clearIdentity() {
  if (!isBrowser()) return;
  [ID_KEY, CRED_KEY, PUB_KEY].forEach((k) => localStorage.removeItem(k));
}
