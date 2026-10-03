// One-time: provision a real Soroswap demo pool on testnet.
// Deploys 2 admin-controlled tokens, creates a pair via the live factory,
// and seeds liquidity via the live router. Writes scripts/pool.json on success.
import fs from "node:fs";
import {
  Keypair, server, fund, addr, u32, i128, u64, str, vecAddr,
  submitOp, callOp, readCall, hostOp, createContractFunc, xdr, TOKEN_WASM, FACTORY, ROUTER, Address,
} from "./lib.mjs";

const DEC = 7n;
const scale = (n) => (BigInt(n) * 10n ** DEC).toString();

// scValToNative may return an Address obj, a string, or an { Ok } wrapper.
function extractAddr(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v.toString === "function" && /^C[A-Z2-7]{55}$/.test(v.toString())) return v.toString();
  if (v.Ok && typeof v.Ok.toString === "function") return v.Ok.toString();
  return null;
}

async function deployToken(kp, label) {
  const { func, predictedId } = createContractFunc(kp.publicKey(), TOKEN_WASM);
  await submitOp(kp, hostOp(func));
  console.log(`deployed ${label}:`, predictedId);
  return predictedId;
}

async function main() {
  const kp = Keypair.random();
  await fund(kp.publicKey());
  console.log("treasury:", kp.publicKey());

  const A = await deployToken(kp, "tokenA");
  const B = await deployToken(kp, "tokenB");

  // initialize(admin, decimal, name, symbol)
  await submitOp(kp, callOp(A, "initialize", [addr(kp.publicKey()), u32(7), str("Obsyd Alpha"), str("OBA")]));
  await submitOp(kp, callOp(B, "initialize", [addr(kp.publicKey()), u32(7), str("Obsyd Beta"), str("OBB")]));
  console.log("initialized both tokens");

  // mint supply to treasury
  await submitOp(kp, callOp(A, "mint", [addr(kp.publicKey()), i128(scale(1000000))]));
  await submitOp(kp, callOp(B, "mint", [addr(kp.publicKey()), i128(scale(1000000))]));
  console.log("minted 1,000,000 each to treasury");

  // create pair via factory
  await submitOp(kp, callOp(FACTORY, "create_pair", [addr(A), addr(B)]));
  const rawPair = await readCall(kp.publicKey(), FACTORY, "get_pair", [addr(A), addr(B)]);
  let pair = extractAddr(rawPair);
  if (!pair) {
    const len = Number(await readCall(kp.publicKey(), FACTORY, "all_pairs_length", []));
    if (len > 0) pair = (await readCall(kp.publicKey(), FACTORY, "all_pairs", [u32(len - 1)]))?.toString?.();
  }
  console.log("pair:", pair, "raw get_pair:", JSON.stringify(rawPair?.toString?.() ?? rawPair));

  // approve router to spend, then add_liquidity.
  // expiration_ledger must sit within the SAC's allowed durability window
  // (testnet max persistent extension ~63,450 ledgers); u32(1e9) triggers
  // Error(Storage, InvalidAction) during simulation.
  const latest = (await server.getLatestLedger()).sequence;
  const expire = latest + 20000; // ~4.5 days, well under the cap
  const la = scale(100000), lb = scale(100000);
  console.log("approve A…", "expire", expire);
  await submitOp(kp, callOp(A, "approve", [addr(kp.publicKey()), addr(ROUTER), i128(la), u32(expire)]));
  console.log("approve B…");
  await submitOp(kp, callOp(B, "approve", [addr(kp.publicKey()), addr(ROUTER), i128(lb), u32(expire)]));
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  console.log("add_liquidity…");
  await submitOp(kp, callOp(ROUTER, "add_liquidity", [
    addr(A), addr(B), i128(la), i128(lb), i128(1), i128(1), addr(kp.publicKey()), u64(deadline),
  ]));
  console.log("added liquidity 100k/100k");

  const reserves = (await readCall(kp.publicKey(), pair, "get_reserves", [])).map((x) => x.toString());
  console.log("pair reserves:", reserves);

  fs.writeFileSync(new URL("./pool.json", import.meta.url), JSON.stringify({
    treasury: kp.publicKey(), treasurySecret: kp.secret(), A, B, pair, decimals: 7,
    symbols: { OBA: A, OBB: B },
  }, null, 2));
  console.log("WROTE scripts/pool.json");
}
main().catch((e) => { console.error("PROVISION FAILED:", String(e?.message || e).slice(0, 300)); process.exit(1); });
