import { NextResponse } from "next/server";
import { fundTestnet, isValidStellarAddress } from "@/lib/stellar";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (config.network !== "testnet") {
    return NextResponse.json(
      { ok: false, error: "funding only available on testnet" },
      { status: 400 },
    );
  }
  let address = "";
  try {
    address = (await req.json())?.address?.trim() || "";
  } catch {
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
