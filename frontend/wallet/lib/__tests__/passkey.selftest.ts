// Self-test for the pure parts of lib/passkey.ts. Run with:
//   node --experimental-strip-types lib/__tests__/passkey.selftest.ts
import { coseToP256, deriveIdentity, toB64url, fromB64url } from "../passkey.ts";

const b64urlToBytes = (s: string) => {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Build a real P-256 key, then encode its COSE EC2 map, then parse it back.
async function makeCose(): Promise<{ cose: Uint8Array; x: Uint8Array; y: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const x = b64urlToBytes(jwk.x!);
  const y = b64urlToBytes(jwk.y!);
  // CBOR: a5 {1:2, 3:-7, -1:1, -2:b'x', -3:b'y'}
  const parts: number[] = [0xa5, 0x01, 0x02, 0x03, 0x36, 0x20, 0x01, 0x21, 0x58, 0x20];
  const head = Uint8Array.from(parts);
  const mid = Uint8Array.from([0x22, 0x58, 0x20]);
  const cose = new Uint8Array(head.length + x.length + mid.length + y.length);
  let p = 0;
  cose.set(head, p); p += head.length;
  cose.set(x, p); p += x.length;
  cose.set(mid, p); p += mid.length;
  cose.set(y, p);
  return { cose, x, y };
}

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  PASS", m); } else { fail++; console.log("  FAIL", m); } };

(async () => {
  const { cose, x, y } = await makeCose();
  const parsed = coseToP256(cose);
  ok(parsed.raw[0] === 0x04, "uncompressed prefix 0x04");
  ok(Buffer.compare(Buffer.from(parsed.raw.slice(1, 33)), Buffer.from(x)) === 0, "X coordinate round-trips");
  ok(Buffer.compare(Buffer.from(parsed.raw.slice(33, 65)), Buffer.from(y)) === 0, "Y coordinate round-trips");
  ok(parsed.raw.length === 65, "raw public key is 65 bytes");

  const id1 = await deriveIdentity(parsed.raw);
  const id2 = await deriveIdentity(parsed.raw);
  ok(/^obsyd_[0-9a-f]{40}$/.test(id1), "identity format obsyd_<40hex>");
  ok(id1 === id2, "derivation is deterministic");

  const { cose: c2 } = await makeCose();
  const p2 = coseToP256(c2);
  const id3 = await deriveIdentity(p2.raw);
  ok(id3 !== id1, "different key → different identity");

  const r = crypto.getRandomValues(new Uint8Array(24));
  ok(Buffer.from(fromB64url(toB64url(r.buffer))).equals(Buffer.from(r)), "base64url round-trip");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
