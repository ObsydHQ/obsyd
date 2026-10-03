// Shared Soroban helpers for Obsyd swap provisioning + execution.
import {
  rpc, xdr, Address, Account, Contract, Keypair, StrKey, Networks, Operation,
  TransactionBuilder, nativeToScVal, scValToNative, authorizeInvocation, Horizon, hash,
} from "@stellar/stellar-sdk";

export const NP = Networks.TESTNET;
export const FACTORY = "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
export const ROUTER  = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
export const TOKEN_WASM = "263d165c1a1bf5a0dddbd0f21744a55cd8cacedf96ade78f53c570df11490e46";

export const server = new rpc.Server("https://soroban-testnet.stellar.org", { allowHttp: false });
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org", { allowHttp: false });
// Load the source account via Horizon (its sequence convention is the one
// TransactionBuilder expects; the Soroban RPC getAccount caused tx_bad_seq).
export const loadAccount = (pub) => horizon.loadAccount(pub);

export const addr = (s) => new Address(s).toScVal();
export const u32 = (n) => nativeToScVal(n, { type: "u32" });
export const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
export const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
export const str = (s) => nativeToScVal(s, { type: "string" });
export const vecAddr = (list) => nativeToScVal(list.map((a) => a), { type: "vec", elem: { type: "address" } });

export async function fund(pub) {
  await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pub)}`);
  await new Promise((r) => setTimeout(r, 3500));
}

// Simulate, sign auth, assemble, submit, poll. Returns the getTransaction response.
export async function submitOp(kp, op, { readCreated = false } = {}) {
  const pub = kp.publicKey();
  const account = await loadAccount(pub);
  const origSeq = account.sequenceNumber();
  const tx = new TransactionBuilder(new Account(pub, origSeq), { fee: "100", networkPassphrase: NP })
    .addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("sim: " + String(sim.error).split("\n")[0]);
  const validUntil = (await server.getLatestLedger()).sequence + 60;
  const signed = [];
  for (const e of (sim.auth || [])) {
    signed.push(await authorizeInvocation({ signer: kp, validUntilLedgerSeq: validUntil, invocation: e.invocation(), networkPassphrase: NP }));
  }
  const op2 = Operation.invokeHostFunction({ func: op.body.invokeHostFunctionOp.hostFunction, auth: signed });
  const tx2 = new TransactionBuilder(new Account(pub, origSeq), { fee: "100", networkPassphrase: NP })
    .addOperation(op2).setTimeout(120).build();
  const built = rpc.assembleTransaction(tx2, sim).build();
  built.sign(kp);
  const res = await server.sendTransaction(built);
  let done = res;
  for (let i = 0; i < 25 && (done.status === "PENDING" || done.status === "NOT_FOUND" || done.status === undefined); i++) {
    await new Promise((r) => setTimeout(r, 1200));
    done = await server.getTransaction(res.hash);
  }
  const ok = done.status === "SUCCESS" || done.successful === true;
  if (!ok) {
    const raw = {
      status: done.status,
      keys: Object.keys(done),
      errResult: (() => { try { return JSON.stringify(res.errorResult ?? done.errorResult).slice(0, 400); } catch { return String(res.errorResult); } })(),
      errXdr: (done.errorResultXdr || res.errorResultXdr || "").slice(0, 60),
      ndiag: (done.diagnosticEventsXdr || res.diagnosticEventsXdr || []).length,
    };
    const errB64 = done.errorResultXdr || res.errorResultXdr;
    const diagSrc = done.diagnosticEventsXdr || res.diagnosticEventsXdr || [];
    let code = "", diag = "";
    if (errB64) {
      try {
        const tr = xdr.TransactionResult.fromXDR(errB64, "base64");
        code = String(tr.result().results()[0].tr().invokeHostFunctionResult()?.switch?.() ?? tr.result().switch?.());
      } catch (e) { code = "decode:" + e.message.slice(0, 60); }
    }
    try {
      const parts = [];
      for (const b of diagSrc) {
        const ev = xdr.DiagnosticEvent.fromXDR(b, "base64").event();
        try {
          const topics = ev.topic().map((t) => JSON.stringify(scValToNative(t))).join(",");
          const data = scValToNative(ev.data());
          parts.push(`${topics}=>${typeof data === "object" ? JSON.stringify(data) : data}`);
        } catch { parts.push(String(ev.type?.())); }
      }
      diag = parts.join(" | ").slice(0, 500);
    } catch (e) { diag = "diag:" + e.message.slice(0, 80); }
    throw new Error("tx failed " + res.hash + " :: " + JSON.stringify(raw) + " code=" + code + " :: " + diag);
  }
  if (readCreated) {
    let tr = done.txResult ?? done.resultXdr;
    if (typeof tr === "string") tr = xdr.TransactionResult.fromXDR(tr, "base64");
    const created = tr.result().results()[0].tr().invokeHostFunctionResult().success().createdContract();
    return { hash: res.hash, created: created.map((h) => StrKey.encodeContract(h.buffer ?? h)) };
  }
  return { hash: res.hash };
}

export function callOp(contractId, method, args = []) {
  return new Contract(contractId).call(method, ...args);
}

// Wrap a raw HostFunction xdr into a proper invokeHostFunction Operation.
export function hostOp(func) {
  return Operation.invokeHostFunction({ func, auth: [] });
}

// Deterministic contract id from a from-address preimage.
export function contractIdFromPreimage(preimage) {
  const networkId = hash(Buffer.from(NP));
  const cid = new xdr.HashIdPreimageContractId({ networkId, contractIdPreimage: preimage });
  const env = xdr.HashIdPreimage.envelopeTypeContractId(cid);
  return StrKey.encodeContract(hash(env.toXDR("raw")));
}

// Build a createContractV2 host function (deploy an instance from an installed wasm hash).
export function createContractFunc(deployerPub, wasmHashHex) {
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const inner = new xdr.ContractIdPreimageFromAddress({
    address: Address.fromString(deployerPub).toScAddress(), salt,
  });
  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(inner);
  const func = xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: preimage,
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHashHex, "hex")),
      constructorArgs: [],
    }),
  );
  let predictedId;
  try { predictedId = contractIdFromPreimage(preimage); } catch { /* derive from result instead */ }
  return { func, predictedId, preimage };
}

// Read-only simulate of a contract call, returns decoded retval.
export async function readCall(pub, contractId, method, args = []) {
  const account = await loadAccount(pub);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NP })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("sim: " + String(sim.error).split("\n")[0]);
  const rv = sim.result?.retval ?? sim.results?.[0]?.retval;
  return rv ? scValToNative(rv) : null;
}

export { Address, StrKey, Keypair, xdr, Contract, scValToNative };
