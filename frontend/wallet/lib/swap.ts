// Obsyd — Soroban/Soroswap swap layer. Server-side (API routes only).
// Talks to the live Soroswap testnet router + a demo pool provisioned by
// scripts/provision-pool.mjs. Uses @stellar/stellar-sdk v17 (rpc namespace).
import fs from "node:fs";
import path from "node:path";
import {
  rpc,
  xdr,
  Address,
  Account,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  authorizeInvocation,
  Horizon,
  StrKey,
} from "@stellar/stellar-sdk";
import { config } from "./config";

export const NETWORK_PASSPHRASE =
  config.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

// Live Soroswap testnet factory + router (mainnet-equivalent deployed on testnet).
export const FACTORY = "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
export const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

const soroban = new rpc.Server(config.sorobanRpcUrl, { allowHttp: config.network === "testnet" });
const horizon = new Horizon.Server(config.horizonUrl, { allowHttp: config.network === "testnet" });

const DECIMALS = 7;
const ONE = 10n ** BigInt(DECIMALS);

/** Parse a decimal string ("1.5") into base units (BigInt) at 7 decimals. */
export function toUnits(human: string): bigint {
  const s = human.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid amount");
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0000000").slice(0, DECIMALS);
  return BigInt(intPart) * ONE + BigInt(frac || "0");
}

/** Format base units (BigInt/string) back to a decimal string with trailing zeros trimmed. */
export function fromUnits(units: bigint | string): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const intPart = a / ONE;
  const frac = (a % ONE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  const out = frac ? `${intPart}.${frac}` : `${intPart}`;
  return neg ? `-${out}` : out;
}

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

// ---- scval helpers ----------------------------------------------------------
const addr = (s: string) => new Address(s).toScVal();
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
const i128 = (n: bigint | string) => nativeToScVal(BigInt(n), { type: "i128" });
const str = (s: string) => nativeToScVal(s, { type: "string" });
const vecAddress = (list: string[]) => xdr.ScVal.scvVec(list.map((a) => addr(a)));

const callOp = (contractId: string, method: string, args: xdr.ScVal[] = []) =>
  new Contract(contractId).call(method, ...args);

function readRetval(sim: any): any {
  const rv = sim.result?.retval ?? sim.results?.[0]?.retval;
  return rv ? scValToNative(rv) : null;
}

/** Read-only simulation of a contract call. */
async function readCall(pub: string, contractId: string, method: string, args: xdr.ScVal[] = []) {
  const account = await horizon.loadAccount(pub);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(callOp(contractId, method, args))
    .setTimeout(60)
    .build();
  const sim = await soroban.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(String(sim.error).split("\n")[0]);
  return readRetval(sim);
}

/** Simulate → sign auth → assemble → sign → submit → poll. */
async function submitOp(kp: Keypair, op: xdr.Operation) {
  const pub = kp.publicKey();
  const account = await horizon.loadAccount(pub);
  const origSeq = account.sequenceNumber();

  const tx = new TransactionBuilder(new Account(pub, origSeq), { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const sim = await soroban.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("sim: " + String(sim.error).split("\n")[0]);
  }

  const validUntil = (await soroban.getLatestLedger()).sequence + 60;
  const signed: xdr.SorobanAuthorizationEntry[] = [];
  for (const e of (sim as any).auth || []) {
    signed.push(
      await authorizeInvocation({
        signer: kp,
        validUntilLedgerSeq: validUntil,
        invocation: e.invocation(),
        networkPassphrase: NETWORK_PASSPHRASE,
      }),
    );
  }

  const op2 = Operation.invokeHostFunction({
    func: (op.body as any).invokeHostFunctionOp.hostFunction,
    auth: signed,
  });
  const tx2 = new TransactionBuilder(new Account(pub, origSeq), { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op2)
    .setTimeout(120)
    .build();
  const built = rpc.assembleTransaction(tx2, sim).build();
  built.sign(kp);

  const res = await soroban.sendTransaction(built);
  let done: any = res;
  for (let i = 0; i < 25 && (done.status === "PENDING" || done.status === "NOT_FOUND" || done.status === undefined); i++) {
    await new Promise((r) => setTimeout(r, 1200));
    done = await soroban.getTransaction(res.hash);
  }
  if (!(done.status === "SUCCESS" || done.successful === true)) {
    const errB64 = done.errorResultXdr || (res as any).errorResultXdr;
    let code = "";
    if (errB64) {
      try {
        const tr: any = xdr.TransactionResult.fromXDR(errB64, "base64");
        code = String(tr.result().results()[0].tr().invokeHostFunctionResult()?.switch?.() ?? tr.result().switch?.());
      } catch {
        /* keep blank */
      }
    }
    throw new Error(`tx failed (${res.hash}) :: ${done.status} ${code}`.trim());
  }
  return { hash: res.hash, ledger: done.latestLedgerSeq };
}

// ---- public API -------------------------------------------------------------

export type TokenMeta = { code: string; contract: string; name: string };

/** Which pair reserve (by index) corresponds to a given token address. */
function reserveFor(reserves: bigint[], token0: string, token1: string, want: string): bigint {
  return want === token0 ? reserves[0] : reserves[1];
}

export type Quote = {
  amountIn: string; // human
  amountOut: string; // human
  amountInUnits: string;
  amountOutUnits: string;
  rate: string; // human "1 FROM = rate TO"
  minOut: string; // human, after slippage
  reserves: [string, string]; // human, ordered [OBA, OBB]
  priceImpactPct: string;
  route: string;
};

/** Quote a swap from token address `from` → `to` for `amountInUnits` base units. */
export async function quoteUnits(pool: PoolConfig, from: string, to: string, amountInUnits: bigint, slippagePct = 0.5): Promise<Quote> {
  const token0 = String(await readCall(pool.treasury, pool.pair, "token_0", []));
  const token1 = String(await readCall(pool.treasury, pool.pair, "token_1", []));
  const rawReserves = (await readCall(pool.treasury, pool.pair, "get_reserves", [])) as any[];
  const reserves = rawReserves.map((r) => BigInt(r.toString()));

  const reserveIn = reserveFor(reserves, token0, token1, from);
  const reserveOut = reserveFor(reserves, token0, token1, to);

  const amountOutUnits = BigInt(await readCall(pool.treasury, ROUTER, "get_amount_out", [
    i128(amountInUnits),
    i128(reserveIn.toString()),
    i128(reserveOut.toString()),
  ]).then((v: any) => v.toString()));

  // min out after slippage (basis points)
  const bps = BigInt(Math.round(slippagePct * 100));
  const minOutUnits = (amountOutUnits * (10000n - bps)) / 10000n;

  const mid = (reserveOut * amountInUnits) / reserveIn; // pre-impact
  const impactPct = mid > 0n
    ? Number(((mid - amountOutUnits) * 10000n) / mid) / 100
    : 0;

  const rate = fromUnits((amountOutUnits * ONE) / amountInUnits); // human TO per 1 FROM

  return {
    amountIn: fromUnits(amountInUnits),
    amountOut: fromUnits(amountOutUnits),
    amountInUnits: amountInUnits.toString(),
    amountOutUnits: amountOutUnits.toString(),
    minOut: fromUnits(minOutUnits),
    rate,
    reserves: [fromUnits(reserves[0]), fromUnits(reserves[1])],
    priceImpactPct: impactPct.toFixed(3),
    route: "Soroswap OBA/OBB",
  };
}

/** Balance of `token` held by `address`. */
export async function tokenBalance(address: string, token: string): Promise<string> {
  const v = await readCall(address, token, "balance", [addr(address)]);
  return v ? BigInt(v.toString()).toString() : "0";
}

/**
 * DEV/DEMO faucet: the pool treasury sends a fixed amount of each demo token
 * to `address` so the wallet holds real, swappable balances. Testnet-only.
 */
export async function fundWithTokens(address: string): Promise<{ OBA: string; OBB: string }> {
  const pool = loadPool();
  if (!pool) throw new Error("pool not provisioned");
  if (!StrKey.isValidEd25519PublicKey(address)) throw new Error("invalid address");
  const kp = Keypair.fromSecret(pool.treasurySecret);
  const each = 1000n * ONE; // 1,000 of each token

  await submitOp(kp, callOp(pool.A, "transfer", [addr(kp.publicKey()), addr(address), i128(each.toString())]));
  await submitOp(kp, callOp(pool.B, "transfer", [addr(kp.publicKey()), addr(address), i128(each.toString())]));

  return { OBA: fromUnits(each), OBB: fromUnits(each) };
}

export type SwapResult = { hash: string; ledger?: number; amountOut: string };

/**
 * Execute a real Soroswap swap on behalf of the account holding `secret`.
 * The router pulls `amountInUnits` of `from` and pays `to` token to the swapper.
 */
export async function executeSwap(opts: {
  secret: string;
  from: string; // token contract address being sold
  to: string; // token contract address being bought
  amountInUnits: string;
  minOutUnits: string;
}): Promise<SwapResult> {
  const pool = loadPool();
  if (!pool) throw new Error("pool not provisioned");
  const kp = Keypair.fromSecret(opts.secret);
  const swapper = kp.publicKey();

  // The recipient must be able to receive the destination token: create a
  // SAC-style balance entry by having the treasury send 0 first (idempotent),
  // otherwise the router's transfer to a brand-new address can hit a missing
  // entry on some token builds. Sending 0 is a no-op for balances.
  try {
    const treasuryKp = Keypair.fromSecret(pool.treasurySecret);
    await submitOp(treasuryKp, callOp(opts.to, "transfer", [addr(treasuryKp.publicKey()), addr(swapper), i128(0n)]));
  } catch {
    /* non-fatal: many token builds create the entry lazily on first receive */
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const before = BigInt(await tokenBalance(swapper, opts.to));
  const op = callOp(ROUTER, "swap_exact_tokens_for_tokens", [
    i128(opts.amountInUnits),
    i128(opts.minOutUnits),
    vecAddress([opts.from, opts.to]),
    addr(swapper),
    u64(deadline),
  ]);

  const { hash, ledger } = await submitOp(kp, op);
  const after = BigInt(await tokenBalance(swapper, opts.to));
  return { hash, ledger, amountOut: fromUnits(after - before) };
}

export { DECIMALS, ONE };
