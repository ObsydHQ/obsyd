import { NextResponse } from "next/server";
import { fetchBalances, fetchActivity, isValidStellarAddress } from "@/lib/stellar";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address")?.trim();

  if (!address || !isValidStellarAddress(address)) {
    return NextResponse.json(
      { ok: false, error: "invalid address" },
      { status: 400 },
    );
  }

  try {
    const [balances, activity] = await Promise.all([
      fetchBalances(address),
      fetchActivity(address).catch(() => []),
    ]);
    return NextResponse.json({
      ok: true,
      network: config.network,
      horizonUrl: config.horizonUrl,
      address,
      balances,
      activity,
    });
  } catch (e: any) {
    const notFound =
      typeof e?.response?.status === "number" && e.response.status === 404;
    return NextResponse.json(
      {
        ok: false,
        error: notFound ? "account not found (fund it first)" : String(e?.message || e),
        notFound,
      },
      { status: notFound ? 404 : 502 },
    );
  }
}
