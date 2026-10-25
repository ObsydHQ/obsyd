import { NextResponse } from "next/server";
import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  StrKey,
} from "@stellar/stellar-sdk";
import { config } from "@/lib/config";
import { readBody, refuse } from "@/lib/custody";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowHttp = config.network === "testnet";
const server = new Horizon.Server(config.horizonUrl, { allowHttp });
const passphrase = config.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * POST /api/send — build an **unsigned** native (XLM) payment and return its XDR.
 *
 * The wallet signs on the device and posts the signed envelope to
 * `/api/tx/submit`, so no secret ever crosses this boundary. That is the whole
 * point: this endpoint can therefore run against any network, and a compromised
 * API can neither move funds nor learn a key.
 */
export async function POST(req: Request) {
  const body = await readBody(req);
  const refused = refuse(body);
  if (refused) return refused;

  const from = String(body?.from || "").trim();
  const to = String(body?.to || "").trim();
  const amount = String(body?.amount || "").trim();

  if (!StrKey.isValidEd25519PublicKey(from) || !StrKey.isValidEd25519PublicKey(to)) {
    return NextResponse.json({ ok: false, error: "invalid address" }, { status: 400 });
  }
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ ok: false, error: "invalid amount" }, { status: 400 });
  }

  try {
    const source = await server.loadAccount(from);
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: passphrase })
      .addOperation(
        Operation.payment({
          destination: to,
          asset: Asset.native(),
          amount,
        }),
      )
      .setTimeout(60)
      .build();

    return NextResponse.json({
      ok: true,
      network: config.network,
      xdr: tx.toXDR(),
      // Exposed so the client can verify it is signing for the intended network.
      networkPassphrase: passphrase,
    });
  } catch (e: any) {
    const notFound = e?.response?.status === 404;
    return NextResponse.json(
      { ok: false, error: notFound ? "account not found (fund it first)" : String(e?.message || e) },
      { status: notFound ? 404 : 502 },
    );
  }
}
