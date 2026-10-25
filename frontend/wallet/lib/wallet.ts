// Obsyd — device-side custody.
//
// The demo keypair is generated *in the browser* and stays there: the API only
// ever sees unsigned XDR going out and signed XDR coming back. Until the
// passkey wallet contract is deployed to the network this runs against, that
// key in localStorage is the signer; the WebAuthn/secp256r1 path in
// contracts/obsyd_account replaces it without changing this boundary.
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const ADDR_KEY = "obsyd.address";
const SECRET_KEY = "obsyd.secret";

const hasWindow = () => typeof window !== "undefined";

export function savedAddress(): string {
  return hasWindow() ? localStorage.getItem(ADDR_KEY) || "" : "";
}

/** Generate a fresh keypair locally and remember it. */
export function createLocalWallet(): { address: string; secret: string } {
  const kp = Keypair.random();
  const address = kp.publicKey();
  const secret = kp.secret();
  if (hasWindow()) {
    localStorage.setItem(ADDR_KEY, address);
    localStorage.setItem(SECRET_KEY, secret);
  }
  return { address, secret };
}

export function saveWallet(address: string, secret: string) {
  if (!hasWindow()) return;
  localStorage.setItem(ADDR_KEY, address);
  localStorage.setItem(SECRET_KEY, secret);
}

export function clearWallet() {
  if (!hasWindow()) return;
  localStorage.removeItem(ADDR_KEY);
  localStorage.removeItem(SECRET_KEY);
}

/** The device signer, or null when no wallet is loaded. */
export function localSigner(): Keypair | null {
  if (!hasWindow()) return null;
  const secret = localStorage.getItem(SECRET_KEY);
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) return null;
  return Keypair.fromSecret(secret);
}
