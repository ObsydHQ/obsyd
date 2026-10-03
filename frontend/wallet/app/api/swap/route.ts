import { NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { config } from "@/lib/config";
import { loadPool, quoteUnits, toUnits, fromUnits, executeSwap } from "@/lib/swap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/swap
 * body: { from, to, amount, secret, slippagePct? }
 * `from`/`to` are token codes (OBA/OBB) or contract addresses.
 * Testnet/demo path: the client supplies the swapper secret it already holds
 * (passkey→smart-contract auth signing is Phase 5c, mirroring /api/send).
 */
export async function POST(req: Request) {
  if (config.network !== "testnet") {
    return NextResponse.json({ ok: false, error: "swap demo runs on testnet only" }, { status: 400 });
  }
  const pool = loadPool();
  if (!pool) {
    return NextResponse.json({ ok: false, error: "pool not provisioned" }, { status: 503 });
  }

  let from = "", to = "", amount = "", secret = "", slippage = 0.5;
  try {
    const b = await req.json();
    from = String(b.from || "").trim();
    to = String(b.to || "").trim();
    amount = String(b.amount || "").trim();
    secret = String(b.secret || "").trim();
    slippage = Number(b.slippagePct ?? 0.5);
  } catch {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }

  const byCode = (v: string) => (pool.symbols[v] ? pool.symbols[v] : /^C[A-Z2-7]{55}$/.test(v) ? v : null);
  const fromAddr = byCode(from);
  const toAddr = byCode(to);
  if (!fromAddr || !toAddr || fromAddr === toAddr) {
    return NextResponse.json({ ok: false, error: "pick two different tokens" }, { status: 400 });
  }
  if (!secret || !/^[SA][A-Z2-7]{55}$/.test(secret)) {
    return NextResponse.json({ ok: false, error: "missing/invalid signer secret" }, { status: 400 });
  }
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ ok: false, error: "invalid amount" }, { status: 400 });
  }

  try {
    const kp = StrKey.isValidEd25519SecretSeed(secret) ? secret : null;
    if (!kp) return NextResponse.json({ ok: false, error: "invalid secret" }, { status: 400 });

    const units = toUnits(amount);
    const q = await quoteUnits(pool, fromAddr, toAddr, units, slippage);
    const minOutUnits = toUnits(q.minOut).toString();
    const result = await executeSwap({
      secret,
      from: fromAddr,
      to: toAddr,
      amountInUnits: units.toString(),
      minOutUnits,
    });
    return NextResponse.json({ ok: true, ...result, quote: q });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
