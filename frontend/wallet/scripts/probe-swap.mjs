// Read-only probe v2: enumerate Soroswap testnet pairs + reserves.
// Run from frontend/wallet: node scripts/probe-swap.mjs
import {
  rpc, Contract, Address, scValToNative, TransactionBuilder, Networks, Keypair,
} from "@stellar/stellar-sdk";

const FACTORY = "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
const ROUTER  = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

const soroban = new rpc.Server("https://soroban-testnet.stellar.org", { allowHttp: false });
const kp = Keypair.random();
const pub = kp.publicKey();
await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pub)}`);
await new Promise((r) => setTimeout(r, 3000));

async function call(contractId, method, args = []) {
  const account = await soroban.getAccount(pub);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  const sim = await soroban.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error((sim.error || "sim fail").split("\n")[0]);
  const retval = sim.results?.[0]?.retval;
  if (!retval) return null;
  return scValToNative(retval);
}

const out = {};
try { out.routerFactory = (await call(ROUTER, "get_factory", []))?.toString?.(); }
catch (e) { out.routerFactoryErr = String(e?.message || e); }

let len = 0;
try { len = Number(await call(FACTORY, "all_pairs_length", [])); } catch (e) { out.lenErr = String(e?.message || e); }
out.allPairsLength = len;
out.pairs = [];
const N = Math.min(len, 50);
for (let i = 0; i < N; i++) {
  try {
    const pairAddr = (await call(FACTORY, "all_pairs", [i]))?.toString?.();
    if (!pairAddr) continue;
    let ta, tb, res;
    try { ta = (await call(pairAddr, "token_a", []))?.toString?.(); } catch {}
    try { tb = (await call(pairAddr, "token_b", []))?.toString?.(); } catch {}
    try { res = (await call(pairAddr, "get_reserves", [])).map((x) => x.toString()); } catch (e) { res = "err:" + String(e?.message||e).split("\n")[0]; }
    out.pairs.push({ i, pairAddr, ta, tb, res });
  } catch (e) {
    out.pairs.push({ i, err: String(e?.message || e).slice(0, 120) });
  }
}
console.log(JSON.stringify(out, null, 2));
