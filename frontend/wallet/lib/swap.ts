// Obsyd — server-only demo pool + faucet.
//
// The transaction machinery lives in `lib/soroban.ts`, which is browser-safe and
// receives its signer from the caller. This module is the only place that reads
// the demo treasury key from disk, and it uses that key solely to sign faucet
// transfers; it is never returned to a client, and no route accepts a secret.
import fs from "node:fs";
import path from "node:path";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { addr, callOp, fromUnits, i128, submitOp, ONE } from "./soroban";

export { toUnits, fromUnits, quoteUnits, tokenBalance, FACTORY, ROUTER, DECIMALS, ONE } from "./soroban";
export type { PoolTokens, Quote } from "./soroban";

// ---- demo pool config (written by scripts/provision-pool.mjs) --------------
export type PoolConfig = {
  treasury: string;
  treasurySecret: string;
  A: string; // token_0 (OBA)
  B: string; // token_1 (OBB)
  pair: string;
  decimals: number;
  symbols: Record<string, string>;
};

let cachedPool: PoolConfig | null = null;

/** Full pool config including the treasury key. Server-side only. */
export function loadPool(): PoolConfig | null {
  if (cachedPool) return cachedPool;
  try {
    const p = path.join(process.cwd(), "scripts", "pool.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    cachedPool = raw as PoolConfig;
    return cachedPool;
  } catch {
    return null;
  }
}

/** The pool minus its treasury half — safe to send to a browser. */
export function publicPool(pool: PoolConfig) {
  return {
    A: pool.A,
    B: pool.B,
    pair: pool.pair,
    decimals: pool.decimals,
    symbols: pool.symbols,
  };
}

/**
 * DEV/DEMO faucet: the pool treasury sends a fixed amount of each demo token to
 * `address`, which also opens the token balance entries the router later pays
 * into. Testnet-only, and the treasury key never leaves this process.
 */
export async function fundWithTokens(address: string): Promise<{ OBA: string; OBB: string }> {
  const pool = loadPool();
  if (!pool) throw new Error("pool not provisioned");
  if (!StrKey.isValidEd25519PublicKey(address)) throw new Error("invalid address");
  const treasury = Keypair.fromSecret(pool.treasurySecret);
  const each = 1000n * ONE; // 1,000 of each token

  await submitOp(treasury, callOp(pool.A, "transfer", [addr(treasury.publicKey()), addr(address), i128(each.toString())]));
  await submitOp(treasury, callOp(pool.B, "transfer", [addr(treasury.publicKey()), addr(address), i128(each.toString())]));

  return { OBA: fromUnits(each), OBB: fromUnits(each) };
}
