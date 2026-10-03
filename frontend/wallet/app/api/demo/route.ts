import { NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { fundTestnet } from "@/lib/stellar";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DEV/DEMO ONLY: mint a fresh testnet account and fund it via friendbot so the
 * wallet UI can display real on-chain balances immediately. Never call on mainnet.
 */
export async function GET() {
  if (config.network !== "testnet") {
    return NextResponse.json({ ok: false, error: "demo only on testnet" }, { status: 400 });
  }
  const kp = Keypair.random();
  const address = kp.publicKey();
  const funded = await fundTestnet(address);

  return NextResponse.json({
    ok: funded,
    address,
    // Test-only secret. Exposed so the demo can sign a test payment. Do not reuse.
    secret: funded ? kp.secret() : undefined,
    note: "testnet demo account — funded by friendbot",
  });
}
