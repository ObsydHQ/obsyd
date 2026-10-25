import { describe, expect, it } from "vitest";
import { coseToP256, deriveIdentity, fromB64url, toB64url } from "../passkey";

/**
 * A COSE EC2 (P-256) public key map, by hand:
 *   a5 { 1:2, 3:-7, -1:1, -2:bytes(x), -3:bytes(y) }
 * which is what `navigator.credentials.create()` exposes from
 * `getPublicKey()`, so this fixture is the wire format the contract parses.
 */
function encodeCose(x: Uint8Array, y: Uint8Array, kty = 2, crv = 1): Uint8Array {
  const head = Uint8Array.from([
    0xa5,
    0x01,
    kty,
    0x03,
    0x36, // -7 (ES256)
    0x20, // -1
    crv,
    0x21, // -2
    0x58,
    0x20,
  ]);
  const mid = Uint8Array.from([0x22 /* -3 */, 0x58, 0x20]);
  const out = new Uint8Array(head.length + x.length + mid.length + y.length);
  let p = 0;
  out.set(head, p);
  p += head.length;
  out.set(x, p);
  p += x.length;
  out.set(mid, p);
  p += mid.length;
  out.set(y, p);
  return out;
}

const X = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));
const Y = Uint8Array.from(Array.from({ length: 32 }, (_, i) => 200 - i));

describe("COSE → SEC1 public key", () => {
  it("expands an EC2 key to the 0x04 || X || Y form the contract stores", () => {
    const { x, y, raw } = coseToP256(encodeCose(X, Y));
    expect(x).toEqual(X);
    expect(y).toEqual(Y);
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);
    expect(raw.slice(1, 33)).toEqual(X);
    expect(raw.slice(33, 65)).toEqual(Y);
  });

  it("refuses a key that is not P-256 EC2", () => {
    expect(() => coseToP256(encodeCose(X, Y, 1))).toThrow(/P-256/); // kty: OKP
    expect(() => coseToP256(encodeCose(X, Y, 2, 2))).toThrow(/P-256/); // crv: P-384
  });

  it("refuses truncated garbage", () => {
    expect(() => coseToP256(Uint8Array.from([0xa5, 0x01]))).toThrow();
  });
});

describe("base64url", () => {
  it("has no padding and is URL-safe, like a WebAuthn challenge", () => {
    const s = toB64url(new Uint8Array(32)); // 32 zero bytes
    expect(s).toHaveLength(43);
    expect(s).not.toMatch(/[+/=]/);
    expect(fromB64url(s)).toEqual(new Uint8Array(32));
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from(Array.from({ length: 90 }, (_, i) => (i * 7) % 256));
    expect(fromB64url(toB64url(bytes))).toEqual(bytes);
  });

  it("decodes the base64url a browser put in clientDataJSON", () => {
    const text = "obsyd.app";
    const b64 = btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(new TextDecoder().decode(fromB64url(b64))).toBe(text);
  });
});

describe("derived identity", () => {
  it("is deterministic for one credential", async () => {
    const { raw } = coseToP256(encodeCose(X, Y));
    expect(await deriveIdentity(raw)).toBe(await deriveIdentity(raw));
  });

  it("is a 20-byte hex digest and changes with the key", async () => {
    const a = await deriveIdentity(coseToP256(encodeCose(X, Y)).raw);
    const b = await deriveIdentity(coseToP256(encodeCose(X, Uint8Array.from(Y).map((v) => v ^ 0x01))).raw);
    expect(a).toMatch(/^obsyd_[0-9a-f]{40}$/);
    expect(b).toMatch(/^obsyd_[0-9a-f]{40}$/);
    expect(a).not.toBe(b);
  });
});
