// Obsyd — live passkey proof on Stellar testnet.
//
// Proves, end to end and on a public network, that a WebAuthn passkey alone
// authorises a payment out of an `obsyd_account` wallet:
//
//   1. upload obsyd_account + obsyd_factory WASMs, deploy the factory, pin the build;
//   2. in a real Chromium browser (Microsoft Edge, headless) create a passkey on a
//      CDP virtual authenticator — the browser's own WebAuthn stack produces the
//      credential, clientDataJSON, authenticatorData and DER signature;
//   3. deploy a wallet for that passkey through the factory and fund it with XLM;
//   4. build `native.transfer(wallet → recipient)`, take the host's auth payload,
//      sign it with `navigator.credentials.get()`, put the assertion in the
//      SorobanAuthorizationEntry and submit. The fee payer is a separate relayer
//      key that has NO authority over the wallet — only the passkey does;
//   5. negative checks: replaying the same assertion and re-pointing it at a
//      different amount must both be refused.
//
// Build the contracts first:
//   cd contracts && cargo build --workspace --release --target wasm32v1-none
// Then:
//   node scripts/passkey-live.mjs
//
// Testnet only. Every key is generated for this run and discarded; the
// passkey lives in a throwaway browser profile.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  rpc, xdr, Account, Address, Asset, Contract, Keypair, Operation, TransactionBuilder, hash,
} from "@stellar/stellar-sdk";
import { NP, server, loadAccount, addr, i128, fund, submitOp, callOp, readCall } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(HERE, "../../../contracts/target/wasm32v1-none/release");
const PORT = Number(process.env.PORT || 5179);
const CDP_PORT = Number(process.env.CDP_PORT || 9337);
const ORIGIN = `http://localhost:${PORT}`;
const RP_ID = "localhost";
const EDGE = process.env.BROWSER ||
  ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
   "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);

const sha256 = (b) => createHash("sha256").update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");
const log = (...a) => console.log(...a);
const rows = [];
let out_credType;
const check = (name, pass, detail = "") => {
  rows.push({ name, pass, detail });
  log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── P-256 signature: WebAuthn DER → raw r‖s, low-s (what secp256r1_verify wants)
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
function derToRawLowS(der) {
  const b = Buffer.from(der);
  if (b[0] !== 0x30) throw new Error("signature is not DER");
  let i = 2;
  const int = () => {
    if (b[i++] !== 0x02) throw new Error("bad DER integer");
    const len = b[i++];
    const v = BigInt("0x" + hex(b.subarray(i, i + len)));
    i += len;
    return v;
  };
  const r = int();
  let s = int();
  const wasHigh = s > P256_N / 2n;
  if (wasHigh) s = P256_N - s;
  const pad = (v) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
  return { raw: Buffer.concat([pad(r), pad(s)]), wasHigh };
}

// ── the page the passkey ceremony runs on ───────────────────────────────────
const PAGE = `<!doctype html><meta charset="utf-8"><title>Obsyd passkey proof</title>
<script>
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
const toHex = (b) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/../g), x => parseInt(x,16));
window.register = async () => {
  const c = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { id: "${RP_ID}", name: "Obsyd" },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "proof", displayName: "Obsyd proof" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  }});
  const spki = new Uint8Array(c.response.getPublicKey());
  return { id: b64u(c.rawId), alg: c.response.getPublicKeyAlgorithm(), publicKey: toHex(spki.slice(-65)) };
};
window.sign = async (credId, challengeHex) => {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: fromHex(challengeHex), rpId: "${RP_ID}", userVerification: "required",
    allowCredentials: [{ type: "public-key", id: unb64u(credId) }],
  }});
  return { authData: toHex(a.response.authenticatorData),
           clientDataJSON: toHex(a.response.clientDataJSON),
           signature: toHex(a.response.signature) };
};
</script><body>Obsyd passkey proof</body>`;

// ── minimal CDP client over Node's built-in WebSocket ───────────────────────
async function openBrowser() {
  if (!EDGE) throw new Error("no Edge/Chrome found; set BROWSER=path/to/browser.exe");
  const profile = mkdtempSync(join(tmpdir(), "obsyd-passkey-"));
  const proc = spawn(EDGE, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", `${ORIGIN}/`,
  ], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.url.startsWith(ORIGIN));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error("browser did not expose the page over CDP");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    const r = await send("Runtime.evaluate", { expression: "typeof window.sign === 'function'", returnByValue: true });
    ready = r.result?.value === true;
    if (!ready) {
      if (i % 8 === 7) await send("Page.navigate", { url: `${ORIGIN}/` });
      await new Promise((res) => setTimeout(res, 250));
    }
  }
  if (!ready) throw new Error(`page at ${ORIGIN} never loaded in the browser`);
  const close = () => {
    try { ws.close(); } catch {}
    proc.kill();
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500);
  };
  return { send, evaluate, close, product: (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).Browser };
}

// ── Soroban: sign an auth entry with the passkey ────────────────────────────
// stellar-sdk v17 XDR is property-based. Address credentials come in two arms:
// V1 signs HashIdPreimageSorobanAuthorization, V2 additionally binds the address.
function addressCreds(entry) {
  const c = entry.credentials;
  if (c.type === "sorobanCredentialsAddress" || c.type === "sorobanCredentialsAddressV2") return c.value;
  throw new Error(`unexpected credential arm ${c.type}`);
}
function authPayload(entry, expiration) {
  const c = addressCreds(entry);
  const common = {
    networkId: hash(Buffer.from(NP)),
    nonce: c.nonce,
    signatureExpirationLedger: expiration,
    invocation: entry.rootInvocation,
  };
  const preimage = entry.credentials.type === "sorobanCredentialsAddressV2"
    ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
        new xdr.HashIdPreimageSorobanAuthorizationWithAddress({ ...common, address: c.address }))
    : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization(common));
  return hash(preimage.toXDR());
}

// `webauthn::Assertion` as a #[contracttype] struct: an ScMap with symbol keys
// in lexicographic order.
function assertionScVal({ publicKey, authData, clientDataJSON, signature, nonce }) {
  const e = (k, v) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  return xdr.ScVal.scvMap([
    e("auth_data", xdr.ScVal.scvBytes(authData)),
    e("client_data_json", xdr.ScVal.scvBytes(clientDataJSON)),
    e("nonce", xdr.ScVal.scvU64(BigInt(nonce))),
    e("public_key", xdr.ScVal.scvBytes(publicKey)),
    e("signature", xdr.ScVal.scvBytes(signature)),
  ]);
}

// Prefer the wallet's own AccountError (e.g. #16 NonceMismatch) over the host's
// generic Error(Auth, InvalidAction) wrapper.
const ACCOUNT_ERRORS = { 6: "WrongRpId", 7: "UserPresenceRequired", 8: "UserVerificationRequired",
  9: "BackupKeyNotAllowed", 10: "BadClientData", 11: "ChallengeMismatch", 12: "BadOrigin",
  13: "UnknownPasskey", 16: "NonceMismatch" };
const simError = (sim) => {
  const s = String(sim.error || "");
  const m = s.match(/Error\(Contract, #(\d+)\)/);
  if (m) return `Error(Contract, #${m[1]}) ${ACCOUNT_ERRORS[m[1]] ?? ""}`.trim();
  return s.split("\n").find((l) => /Error\(|error/i.test(l)) || s.slice(0, 200);
};
const refusedWith = (sim, code) => !rpc.Api.isSimulationSuccess(sim) && simError(sim).includes(`#${code})`);

async function buildPasskeyTransfer({ relayer, sac, wallet, to, amount, browser, cred, publicKey, nonce, reuse }) {
  const call = (auth) => Operation.invokeContractFunction({
    contract: sac, function: "transfer", args: [addr(wallet), addr(to), i128(amount)], auth,
  });
  const op = call([]);
  const acct = await loadAccount(relayer.publicKey());
  const seq = acct.sequenceNumber();
  const draft = new TransactionBuilder(new Account(relayer.publicKey(), seq), { fee: "100", networkPassphrase: NP })
    .addOperation(op).setTimeout(120).build();
  const sim1 = await server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(sim1)) throw new Error("record sim: " + simError(sim1));
  const entries = sim1.result.auth;
  if (entries.length !== 1) throw new Error(`expected one auth entry for the wallet, got ${entries.length}`);
  const entry = entries[0];
  const expiration = (await server.getLatestLedger()).sequence + 100;
  addressCreds(entry).signatureExpirationLedger = expiration;
  const payload = authPayload(entry, expiration);

  let assertion = reuse;
  if (!assertion) {
    const a = await browser.evaluate(`window.sign(${JSON.stringify(cred.id)}, ${JSON.stringify(hex(payload))})`);
    const { raw, wasHigh } = derToRawLowS(Buffer.from(a.signature, "hex"));
    assertion = {
      publicKey, nonce,
      authData: Buffer.from(a.authData, "hex"),
      clientDataJSON: Buffer.from(a.clientDataJSON, "hex"),
      signature: raw, wasHigh, derLen: a.signature.length / 2,
    };
  }
  addressCreds(entry).signature = assertionScVal(assertion);
  out_credType = entry.credentials.type;

  const op2 = call([entry]);
  const tx = new TransactionBuilder(new Account(relayer.publicKey(), seq), { fee: "100", networkPassphrase: NP })
    .addOperation(op2).setTimeout(120).build();
  // Enforcing-mode simulation: this runs the wallet's real __check_auth.
  const sim2 = await server.simulateTransaction(tx);
  return { tx, sim2, assertion, payload };
}

async function submit(tx, sim, kp) {
  const built = rpc.assembleTransaction(tx, sim).build();
  built.sign(kp);
  const res = await server.sendTransaction(built);
  if (res.status === "ERROR") throw new Error("send rejected: " + JSON.stringify(res.errorResult));
  let done;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    done = await server.getTransaction(res.hash);
    if (done.status !== "NOT_FOUND") break;
  }
  return { hash: res.hash, done };
}

const xlmBalance = async (sac, who, from) => BigInt(await readCall(from, sac, "balance", [addr(who)]));

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const accountWasm = readFileSync(join(WASM_DIR, "obsyd_account.wasm"));
  const factoryWasm = readFileSync(join(WASM_DIR, "obsyd_factory.wasm"));
  const accountHash = sha256(accountWasm);

  // Loopback only, on both stacks: browsers may resolve `localhost` to ::1.
  const handler = (_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); };
  const servers = [http.createServer(handler), http.createServer(handler)];
  await new Promise((r) => servers[0].listen(PORT, "127.0.0.1", r));
  await new Promise((r) => servers[1].listen(PORT, "::1", r).on("error", r));
  const srv = { close: () => servers.forEach((s) => s.close()) };

  const relayer = Keypair.random();   // deploys contracts and pays fees; never controls the wallet
  const recipient = Keypair.random();
  log(`relayer   ${relayer.publicKey()}\nrecipient ${recipient.publicKey()}`);
  await Promise.all([fund(relayer.publicKey()), fund(recipient.publicKey())]);

  log("uploading WASMs…");
  const upA = await submitOp(relayer, Operation.uploadContractWasm({ wasm: accountWasm }));
  const upF = await submitOp(relayer, Operation.uploadContractWasm({ wasm: factoryWasm }));
  log("deploying factory…");
  const depF = await submitOp(relayer, Operation.createCustomContract({
    address: new Address(relayer.publicKey()),
    wasmHash: sha256(factoryWasm),
    salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
    constructorArgs: [addr(relayer.publicKey())],
  }), { returnValue: true });
  const factory = depF.returnValue;
  check("factory deployed", factory?.startsWith("C"), factory);
  const pin = await submitOp(relayer, callOp(factory, "set_wasm_hash", [xdr.ScVal.scvBytes(accountHash)]));
  check("factory pinned to obsyd_account build", true, hex(accountHash));

  const browser = await openBrowser();
  const out = { network: "testnet", browser: browser.product, origin: ORIGIN, rpId: RP_ID };
  try {
    await browser.send("WebAuthn.enable");
    await browser.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    }});
    const cred = await browser.evaluate("window.register()");
    const publicKey = Buffer.from(cred.publicKey, "hex");
    check("passkey created in browser", cred.alg === -7 && publicKey.length === 65 && publicKey[0] === 4,
      `${browser.product}, ES256, credential ${cred.id.slice(0, 16)}…`);

    const pkArg = xdr.ScVal.scvBytes(publicKey);
    const preview = await readCall(relayer.publicKey(), factory, "preview_address", [pkArg]);
    const create = await submitOp(relayer, callOp(factory, "create_account", [
      pkArg, xdr.ScVal.scvBytes(sha256(RP_ID)), xdr.ScVal.scvBytes(Buffer.from(ORIGIN)),
      xdr.ScVal.scvBool(true), xdr.ScVal.scvBool(true), xdr.ScVal.scvBool(false),
    ]), { returnValue: true });
    const wallet = create.returnValue;
    check("wallet deployed at the counterfactual address", wallet === preview, wallet);

    const sac = Asset.native().contractId(NP);
    const FUND = 100_0000000n;   // 100 XLM
    const SEND = 25_0000000n;    // 25 XLM
    const fundTx = await submitOp(relayer, new Contract(sac).call("transfer",
      addr(relayer.publicKey()), addr(wallet), i128(FUND)));
    check("wallet funded", (await xlmBalance(sac, wallet, relayer.publicKey())) === FUND, "100 XLM");

    // The proof: a passkey-authorised payment, fee paid by an unrelated relayer.
    const toBefore = await xlmBalance(sac, recipient.publicKey(), relayer.publicKey());
    const t = await buildPasskeyTransfer({ relayer, sac, wallet, to: recipient.publicKey(), amount: SEND,
      browser, cred, publicKey, nonce: 0 });
    const cd = JSON.parse(t.assertion.clientDataJSON.toString());
    log(`clientDataJSON: ${t.assertion.clientDataJSON.toString()}`);
    log(`signature: DER ${t.assertion.derLen} bytes → raw 64${t.assertion.wasHigh ? " (high-s, normalised)" : " (already low-s)"}`);
    check("challenge = base64url(Soroban auth payload)",
      cd.challenge === Buffer.from(t.payload).toString("base64url"), cd.challenge);
    check("enforcing simulation runs __check_auth and passes", rpc.Api.isSimulationSuccess(t.sim2),
      rpc.Api.isSimulationSuccess(t.sim2) ? "" : simError(t.sim2));
    if (!rpc.Api.isSimulationSuccess(t.sim2)) { console.error("cred arm:", out_credType); console.error(String(t.sim2.error).slice(0, 4000)); throw new Error("stop: passkey auth rejected in simulation"); }
    const sent = await submit(t.tx, t.sim2, relayer);
    check("passkey-signed transfer succeeded on testnet", sent.done.status === "SUCCESS", sent.hash);
    const walletAfter = await xlmBalance(sac, wallet, relayer.publicKey());
    const toAfter = await xlmBalance(sac, recipient.publicKey(), relayer.publicKey());
    check("25 XLM left the wallet and reached the recipient",
      walletAfter === FUND - SEND && toAfter - toBefore === SEND,
      `wallet ${Number(walletAfter) / 1e7} XLM, recipient +${Number(toAfter - toBefore) / 1e7} XLM`);
    const nonceAfter = BigInt(await readCall(relayer.publicKey(), wallet, "passkey_nonce", [pkArg]));
    check("wallet advanced the passkey nonce", nonceAfter === 1n, `nonce ${nonceAfter}`);

    // Replay: the same assertion on a fresh transaction must not work again.
    const replay = await buildPasskeyTransfer({ relayer, sac, wallet, to: recipient.publicKey(), amount: SEND,
      browser, cred, publicKey, nonce: 0, reuse: t.assertion });
    check("replayed assertion refused by the wallet (NonceMismatch)", refusedWith(replay.sim2, 16), simError(replay.sim2));

    // Re-pointing: a fresh, correctly-nonced assertion for 1 XLM, attached to a
    // 50 XLM transfer. The challenge no longer matches the payload.
    const small = await buildPasskeyTransfer({ relayer, sac, wallet, to: recipient.publicKey(), amount: 1_0000000n,
      browser, cred, publicKey, nonce: 1 });
    const swapped = await buildPasskeyTransfer({ relayer, sac, wallet, to: recipient.publicKey(), amount: 50_0000000n,
      browser, cred, publicKey, nonce: 1, reuse: small.assertion });
    check("assertion re-pointed at a different amount refused (ChallengeMismatch)",
      refusedWith(swapped.sim2, 11), simError(swapped.sim2));

    Object.assign(out, {
      factory, accountWasmHash: hex(accountHash), wallet, recipient: recipient.publicKey(),
      relayer: relayer.publicKey(), passkeyPublicKey: hex(publicKey),
      tx: { uploadAccount: upA.hash, uploadFactory: upF.hash, deployFactory: depF.hash, pinWasm: pin.hash,
            createWallet: create.hash, fundWallet: fundTx.hash, passkeyTransfer: sent.hash },
      authCredentialArm: out_credType,
      clientDataJSON: t.assertion.clientDataJSON.toString(),
    });
  } finally {
    browser.close();
    srv.close();
  }

  const failed = rows.filter((r) => !r.pass);
  out.checks = rows;
  writeFileSync(join(HERE, "passkey-proof.json"), JSON.stringify(out, null, 2));
  log(`\nexplorer: https://stellar.expert/explorer/testnet/tx/${out.tx?.passkeyTransfer}`);
  log(`wallet:   https://stellar.expert/explorer/testnet/contract/${out.wallet}`);
  log(`${rows.length - failed.length}/${rows.length} checks passed; written to scripts/passkey-proof.json`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
