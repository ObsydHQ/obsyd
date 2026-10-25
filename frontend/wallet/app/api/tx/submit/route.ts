import { NextResponse } from "next/server";
import { Horizon, Transaction, Networks } from "@stellar/stellar-sdk";
import { config } from "@/lib/config";
import { readBody, refuse } from "@/lib/custody";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowHttp = config.network === "testnet";
const server = new Horizon.Server(config.horizonUrl, { allowHttp });
const passphrase = config.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * POST /api/tx/submit — relay an envelope the wallet already signed.
 *
 * This route is a dumb relay: it re-parses the XDR against the configured
 * network, refuses anything unsigned, and submits. It holds no keys and has no
 * authority over the funds, so compromising it cannot steal anything.
 */
export async function POST(req: Request) {
  const body = await readBody(req);
  const refused = refuse(body);
  if (refused) return refused;

  const envelope = String(body?.xdr || "").trim();
  if (!envelope) {
    return NextResponse.json({ ok: false, error: "missing xdr" }, { status: 400 });
  }

  let tx: Transaction;
  try {
    tx = new Transaction(envelope, passphrase);
  } catch {
    return NextResponse.json({ ok: false, error: "xdr does not parse for this network" }, { status: 400 });
  }
  if (tx.signatures.length === 0) {
    return NextResponse.json({ ok: false, error: "transaction is not signed" }, { status: 400 });
  }

  try {
    const result = await server.submitTransaction(tx);
    return NextResponse.json({ ok: true, hash: result.hash, ledger: result.ledger });
  } catch (e: any) {
    const extras = e?.response?.data?.extras;
    return NextResponse.json(
      {
        ok: false,
        error: String(e?.message || e),
        result_codes: extras?.result_codes,
        result_xdr: extras?.result_xdr,
      },
      { status: 502 },
    );
  }
}
