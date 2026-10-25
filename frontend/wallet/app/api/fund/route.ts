import { NextResponse } from "next/server";
import { fundTestnet, isValidStellarAddress } from "@/lib/stellar";
import { config } from "@/lib/config";
import { readBody, refuse } from "@/lib/custody";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (config.network !== "testnet") {
    return NextResponse.json(
      { ok: false, error: "funding only available on testnet" },
      { status: 400 },
    );
  }
  const body = await readBody(req);
  const refused = refuse(body);
  if (refused) return refused;
  let address = String(body?.address || "").trim();
  if (!address) {
    address = new URL(req.url).searchParams.get("address")?.trim() || "";
  }

  if (!address || !isValidStellarAddress(address)) {
    return NextResponse.json({ ok: false, error: "invalid address" }, { status: 400 });
  }

  const ok = await fundTestnet(address);
  return NextResponse.json(
    ok ? { ok: true, address } : { ok: false, error: "friendbot failed" },
    { status: ok ? 200 : 502 },
  );
}
