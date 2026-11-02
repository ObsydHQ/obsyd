// Obsyd — live custody-boundary audit.
//
// `lib/__tests__/custody.test.ts` proves by reading the source that no request
// the wallet builds can carry a private key. This proves the same thing over the
// wire against a running server, and additionally that the server refuses one if
// it arrives: fund two throwaway testnet accounts, build a payment through
// `/api/send`, sign it here, relay it through `/api/tx/submit`, then plant a
// secret in three request bodies and check each is refused.
//
//   npm run dev                       # serves http://localhost:3000
//   node scripts/custody-live.mjs     # or pass a base URL / set OBSYD_BASE_URL
//
// Testnet only, and the keys it uses are generated for this run and thrown away.
import { Keypair, Transaction, Networks } from "@stellar/stellar-sdk";

const BASE = (process.argv[2] || process.env.OBSYD_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const NP = Networks.TESTNET;
const secretShape = /S[A-Z2-7]{55}/;

const wire = [];
const post = async (path, body, intentional = false) => {
  wire.push({ path, body: JSON.stringify(body), intentional });
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const get = async (path) => {
  wire.push({ path, body: null });
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, text: await r.text() };
};

const rows = [];
const check = (name, pass, detail) => {
  rows.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const finish = (code) => {
  const failed = rows.filter((r) => !r.pass);
  if (rows.length) {
    console.log(`\n${rows.length - failed.length}/${rows.length} checks passed`);
  }
  process.exit(code);
};

const failHard = (message) => {
  console.error(message);
  finish(1);
};

try {
  // Preflight: confirm the wallet API is up before spending faucet / signing work.
  const probe = await get("/api/balance?address=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
  if (probe.status === 0 || probe.status >= 500 || /ECONNREFUSED|fetch failed/i.test(probe.text || "")) {
    failHard(
      `Cannot reach ${BASE} (is \`npm run dev\` running on port 3000?). ` +
        `Pass a base URL as the first argument or set OBSYD_BASE_URL.`,
    );
  }
} catch (err) {
  const why = err?.cause?.code || err?.code || err?.message || String(err);
  failHard(
    `Cannot reach ${BASE} (${why}). Is \`npm run dev\` running? ` +
      `Pass a base URL as the first argument or set OBSYD_BASE_URL.`,
  );
}

try {
  // ---- throwaway wallets -----------------------------------------------------
  const sender = Keypair.random();
  const recipient = Keypair.random();

  const f1 = await post("/api/fund", { address: sender.publicKey() });
  check("POST /api/fund accepts a public address", f1.json?.ok === true, `status ${f1.status}`);
  const f2 = await post("/api/fund", { address: recipient.publicKey() });
  check("POST /api/fund accepts a second address", f2.json?.ok === true, `status ${f2.status}`);

  // ---- the guard: a secret is refused, loudly -------------------------------
  const s = sender.secret();
  const bad = await post("/api/send", { from: sender.publicKey(), to: recipient.publicKey(), amount: "5", secret: s }, true);
  check("/api/send refuses a body carrying a secret", bad.status === 400 && bad.json?.ok === false, `${bad.status} ${bad.json?.error}`);

  const badFund = await post("/api/fund", { address: recipient.publicKey(), secret: s }, true);
  check("/api/fund refuses a body carrying a secret", badFund.status === 400, `${badFund.status} ${badFund.json?.error}`);

  const good = await post("/api/send", { from: sender.publicKey(), to: recipient.publicKey(), amount: "5" });
  const hasXdr = good.json?.ok === true && typeof good.json?.xdr === "string";
  check("/api/send returns XDR", hasXdr, `status ${good.status}`);

  let unsigned = null;
  if (hasXdr) {
    try {
      unsigned = new Transaction(good.json.xdr, NP);
      check("what /api/send returns is unsigned", unsigned.signatures.length === 0, `${unsigned.signatures.length} signature(s)`);
      check("/api/send names the network it built for", good.json.networkPassphrase === NP, good.json.network);
    } catch (err) {
      check("what /api/send returns is unsigned", false, err?.message || String(err));
      check("/api/send names the network it built for", false, "skipped: invalid XDR");
    }
  } else {
    check("what /api/send returns is unsigned", false, "skipped: /api/send did not return XDR");
    check("/api/send names the network it built for", false, "skipped: /api/send did not return XDR");
  }

  if (unsigned) {
    const relay = await post("/api/tx/submit", { xdr: good.json.xdr });
    check("/api/tx/submit refuses an unsigned envelope", relay.status === 400 && /not signed/.test(relay.json?.error || ""), `${relay.status} ${relay.json?.error}`);

    unsigned.sign(sender);
    const sent = await post("/api/tx/submit", { xdr: unsigned.toXDR() });
    check("the device-signed envelope is relayed", sent.json?.ok === true && !!sent.json?.hash, `${sent.status} ${sent.json?.error || sent.json?.hash}`);
  } else {
    check("/api/tx/submit refuses an unsigned envelope", false, "skipped: no unsigned XDR");
    check("the device-signed envelope is relayed", false, "skipped: no unsigned XDR");
  }

  const bal = await get(`/api/balance?address=${encodeURIComponent(recipient.publicKey())}`);
  let balJson = null;
  try {
    balJson = JSON.parse(bal.text);
  } catch (err) {
    check("the recipient received the payment", false, `balance response not JSON (${bal.status}): ${err.message}`);
  }
  if (balJson) {
    const xlm = (balJson.balances || []).find((b) => b.code === "XLM");
    check("the recipient received the payment", Number(xlm?.amount) >= 10005, `balance ${xlm?.amount}`);
  }

  // ---- the swap half: quote is read-only, keys are not in it ----------------
  const quote = await get(`/api/swap/quote?from=OBA&to=OBB&amount=10&address=${sender.publicKey()}`);
  let quoteJson = null;
  try {
    quoteJson = JSON.parse(quote.text);
  } catch (err) {
    check("/api/swap/quote still quotes", false, `quote response not JSON (${quote.status}): ${err.message}`);
  }
  if (quoteJson) {
    check("/api/swap/quote still quotes", quoteJson.ok === true, `${quote.status} ${quoteJson.error || quoteJson.quote?.amountOut}`);
    if (quoteJson.ok) {
      check("the quote response holds no treasury key", !secretShape.test(quote.text), `${Object.keys(quoteJson.pool || {}).join(",")}`);
      const faucet = await post("/api/swap/faucet", { address: sender.publicKey(), secret: s }, true);
      check("/api/swap/faucet refuses a body carrying a secret", faucet.status === 400, `${faucet.status} ${faucet.json?.error}`);
    }
  }

  // ---- nothing that left this process was a key ----------------------------
  const accidental = wire.filter((w) => !w.intentional && w.body && secretShape.test(w.body));
  check("every ordinary request body is public data", accidental.length === 0, `${wire.length} requests: ${wire.map((w) => w.path).join(", ")}`);
  const planted = wire.filter((w) => w.intentional);
  check("the planted secrets really were on the wire to be refused", planted.length === 3, `${planted.length} negative probes`);

  console.log("\nrequest bodies seen on the wire:");
  for (const w of wire) {
    // The negative probes carry a real (throwaway) key; never print one, even to
    // a terminal that might be recorded.
    const shown = w.body ? w.body.replace(new RegExp(secretShape.source, "g"), "<secret-shaped>") : "(no body)";
    console.log(`  ${w.path}  ${shown.slice(0, 120)}`);
  }

  finish(rows.some((r) => !r.pass) ? 1 : 0);
} catch (err) {
  const why = err?.cause?.code || err?.code || err?.message || String(err);
  console.error(`custody-live aborted: ${why}`);
  finish(1);
}
