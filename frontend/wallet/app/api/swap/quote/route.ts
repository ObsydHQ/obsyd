import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { loadPool, quoteUnits, toUnits, tokenBalance, fromUnits } from "@/lib/swap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/swap/quote?from=<code|address>&to=<code|address>&amount=1.5&address=G...
 * Quotes a live Soroswap swap against the provisioned pool. Optionally returns
 * the swapper's balances so the UI can cap the input.
 */
export async function GET(req: Request) {
  if (config.network !== "testnet") {
    return NextResponse.json({ ok: false, error: "swap demo runs on testnet only" }, { status: 400 });
  }
  const pool = loadPool();
  if (!pool) {
    return NextResponse.json({ ok: false, error: "pool not provisioned (run scripts/provision-pool.mjs)" }, { status: 503 });
  }

  const url = new URL(req.url);
  const byCode = (v: string | null) => {
    const s = (v || "").trim();
    if (pool.symbols[s]) return pool.symbols[s];
    if (/^C[A-Z2-7]{55}$/.test(s)) return s;
    return null;
  };
  const from = byCode(url.searchParams.get("from"));
  const to = byCode(url.searchParams.get("to"));
  const amountRaw = url.searchParams.get("amount") || "";
  const address = url.searchParams.get("address")?.trim() || "";

  if (!from || !to || from === to) {
    return NextResponse.json({ ok: false, error: "pick two different tokens" }, { status: 400 });
  }
  if (!amountRaw || Number.isNaN(Number(amountRaw)) || Number(amountRaw) <= 0) {
    return NextResponse.json({ ok: false, error: "invalid amount" }, { status: 400 });
  }

  let units: bigint;
  try {
    units = toUnits(amountRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid amount" }, { status: 400 });
  }

  try {
    const quote = await quoteUnits(pool, from, to, units);
    const codes = Object.keys(pool.symbols);
    const balOba = address ? await tokenBalance(address, pool.A).catch(() => "0") : "0";
    const balObb = address ? await tokenBalance(address, pool.B).catch(() => "0") : "0";
    return NextResponse.json({
      ok: true,
      quote,
      tokens: [
        { code: codes[0], contract: pool.A, balance: fromUnits(BigInt(balOba)) },
        { code: codes[1], contract: pool.B, balance: fromUnits(BigInt(balObb)) },
      ],
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
