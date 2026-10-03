import { NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { config } from "@/lib/config";
import { loadPool, fundWithTokens } from "@/lib/swap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/swap/faucet  body: { address }
 * DEV/DEMO ONLY: the pool treasury sends 1,000 OBA + 1,000 OBB to `address` so
 * the wallet can perform real swaps. Testnet-only, treasury secret stays server-side.
 */
export async function POST(req: Request) {
  if (config.network !== "testnet") {
    return NextResponse.json({ ok: false, error: "faucet only on testnet" }, { status: 400 });
  }
  if (!loadPool()) {
    return NextResponse.json({ ok: false, error: "pool not provisioned" }, { status: 503 });
  }
  let address = "";
  try {
    address = String((await req.json())?.address || "").trim();
  } catch {
    address = new URL(req.url).searchParams.get("address")?.trim() || "";
  }
  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json({ ok: false, error: "invalid address" }, { status: 400 });
  }

  try {
    const sent = await fundWithTokens(address);
    return NextResponse.json({ ok: true, address, sent });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
