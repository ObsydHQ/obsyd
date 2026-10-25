// Obsyd — isomorphic Soroban transaction layer.
//
// Deliberately free of `node:fs`, `process.cwd()` and any private key so it can be
// imported from a client component: the signer is always supplied by the caller,
// and in the browser it never leaves the device. Server-only conveniences
// (loading the demo pool config, the treasury faucet) live in `lib/swap.ts`.
//
// Uses @stellar/stellar-sdk v17 (`rpc` namespace).
import {
  rpc,
  xdr,
  Address,
  Account,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  authorizeInvocation,
  Horizon,
} from "@stellar/stellar-sdk";
import { config } from "./config";

export const NETWORK_PASSPHRASE =
  config.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

// Live Soroswap testnet factory + router. Mainnet equivalents are different and
// must be supplied via env before a mainnet demo (see README "Networks").
export const FACTORY = process.env.NEXT_PUBLIC_SOROSWAP_FACTORY || "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
export const ROUTER = process.env.NEXT_PUBLIC_SOROSWAP_ROUTER || "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

const allowHttp = config.network === "testnet";
const soroban = new rpc.Server(config.sorobanRpcUrl, { allowHttp });
const horizon = new Horizon.Server(config.horizonUrl, { allowHttp });

export const DECIMALS = 7;
export const ONE = 10n ** BigInt(DECIMALS);

/** Parse a decimal string ("1.5") into base units (BigInt) at 7 decimals. */
export function toUnits(human: string): bigint {
  const s = human.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid amount");
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0000000").slice(0, DECIMALS);
  return BigInt(intPart) * ONE + BigInt(frac || "0");
}

/** Format base units (BigInt/string) back to a decimal string, trailing zeros trimmed. */
export function fromUnits(units: bigint | string): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const intPart = a / ONE;
  const frac = (a % ONE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  const out = frac ? `${intPart}.${frac}` : `${intPart}`;
  return neg ? `-${out}` : out;
}

/** The public half of the demo pool config — safe to hand to a browser. */
export type PoolTokens = {
  A: string; // token_0 (OBA)
  B: string; // token_1 (OBB)
  pair: string;
  decimals: number;
  symbols: Record<string, string>;
};

// ---- scval helpers ----------------------------------------------------------
export const addr = (s: string) => new Address(s).toScVal();
export const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
export const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
export const i128 = (n: bigint | string) => nativeToScVal(BigInt(n), { type: "i128" });
export const str = (s: string) => nativeToScVal(s, { type: "string" });
export const vecAddress = (list: string[]) => xdr.ScVal.scvVec(list.map((a) => addr(a)));

export const callOp = (contractId: string, method: string, args: xdr.ScVal[] = []) =>
  new Contract(contractId).call(method, ...args);

export function readRetval(sim: any): any {
  const rv = sim.result?.retval ?? sim.results?.[0]?.retval;
  return rv ? scValToNative(rv) : null;
}

/** Read-only simulation of a contract call, paid for by `pub`'s account entry. */
export async function readCall(
  pub: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
) {
  const account = await horizon.loadAccount(pub);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(callOp(contractId, method, args))
    .setTimeout(60)
    .build();
  const sim = await soroban.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(String(sim.error).split("\n")[0]);
  return readRetval(sim);
}

export type Signer = InstanceType<typeof import("@stellar/stellar-sdk").Keypair>;

/**
 * Simulate → sign the auth entries → assemble → sign the transaction → submit →
 * poll for the final result.
 *
 * `signer` is the only secret-bearing argument and is used exclusively to produce
 * signatures; it is never serialized into a request body.
 */
export async function submitOp(signer: Signer, op: xdr.Operation) {
  const pub = signer.publicKey();
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
        signer,
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
  // TransactionBuilder mutates the source account's sequence, so every attempt
  // rebuilds from a fresh Account with the original sequence number.
  const built = rpc.assembleTransaction(tx2, sim).build();
  built.sign(signer);

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

// ---- quoting and swapping ---------------------------------------------------

/** Which pair reserve (by index) corresponds to a given token address. */
export function reserveFor(reserves: bigint[], token0: string, token1: string, want: string): bigint {
  return want === token0 ? reserves[0] : reserves[1];
}

export type Quote = {
  amountIn: string;
  amountOut: string;
  amountInUnits: string;
  amountOutUnits: string;
  rate: string;
  minOut: string;
  reserves: [string, string];
  priceImpactPct: string;
  route: string;
};

/** Quote a Soroswap x*y=k swap straight off the live pair reserves. */
export async function quoteUnits(
  pool: PoolTokens,
  payer: string,
  from: string,
  to: string,
  amountInUnits: bigint,
  slippagePct = 0.5,
): Promise<Quote> {
  const token0 = String(await readCall(payer, pool.pair, "token_0", []));
  const token1 = String(await readCall(payer, pool.pair, "token_1", []));
  const rawReserves = (await readCall(payer, pool.pair, "get_reserves", [])) as any[];
  const reserves = rawReserves.map((r) => BigInt(r.toString()));

  const reserveIn = reserveFor(reserves, token0, token1, from);
  const reserveOut = reserveFor(reserves, token0, token1, to);

  const amountOutUnits = BigInt(
    await readCall(payer, ROUTER, "get_amount_out", [
      i128(amountInUnits),
      i128(reserveIn.toString()),
      i128(reserveOut.toString()),
    ]).then((v: any) => v.toString()),
  );

  const bps = BigInt(Math.round(slippagePct * 100));
  const minOutUnits = (amountOutUnits * (10000n - bps)) / 10000n;

  const mid = (reserveOut * amountInUnits) / reserveIn; // pre-impact
  const impactPct = mid > 0n ? Number(((mid - amountOutUnits) * 10000n) / mid) / 100 : 0;
  const rate = fromUnits((amountOutUnits * ONE) / amountInUnits);

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
 * Swap `amountInUnits` of `from` for at least `minOutUnits` of `to` on Soroswap,
 * returning the *delta* actually received.
 */
export async function swapExactTokens(
  signer: Signer,
  pool: PoolTokens,
  opts: { from: string; to: string; amountInUnits: string; minOutUnits: string },
) {
  const me = signer.publicKey();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const before = BigInt(await tokenBalance(me, opts.to));
  const op = callOp(ROUTER, "swap_exact_tokens_for_tokens", [
    i128(opts.amountInUnits),
    i128(opts.minOutUnits),
    vecAddress([opts.from, opts.to]),
    addr(me),
    u64(deadline),
  ]);
  const { hash, ledger } = await submitOp(signer, op);
  const after = BigInt(await tokenBalance(me, opts.to));
  return { hash, ledger, amountOut: fromUnits(after - before) };
}

export { soroban, horizon };
