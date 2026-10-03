import { NextResponse } from "next/server";
import {
  Horizon,
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  StrKey,
} from "@stellar/stellar-sdk";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const server = new Horizon.Server(config.horizonUrl, { allowHttp: false });
const passphrase = config.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Build, sign, and submit a native (XLM) payment on the configured network.
 * Testnet/demo path: the client supplies the sender secret it already holds.
 * (Passkey→smart-contract auth signing is Phase 5c.)
 */
export async function POST(req: Request) {
  if (config.network !== "testnet") {
    return NextResponse.json({ ok: false, error: "send demo runs on testnet only" }, { status: 400 });
  }

  let from = "", to = "", amount = "", secret = "";
  try {
    const body = await req.json();
    from = (body.from || "").trim();
    to = (body.to || "").trim();
    amount = String(body.amount || "").trim();
    secret = (body.secret || "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }

  if (!StrKey.isValidEd25519PublicKey(from) || !StrKey.isValidEd25519PublicKey(to)) {
    return NextResponse.json({ ok: false, error: "invalid address" }, { status: 400 });
  }
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ ok: false, error: "invalid amount" }, { status: 400 });
  }
  if (!secret) {
    return NextResponse.json({ ok: false, error: "missing signer (passkey auth lands in 5c)" }, { status: 400 });
  }

  try {
    const source = await server.loadAccount(from);
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: passphrase,
    })
      .addOperation(
        Operation.payment({
          destination: to,
          asset: Asset.native(),
          amount,
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(Keypair.fromSecret(secret));
    const result = await server.submitTransaction(tx);
    return NextResponse.json({
      ok: true,
      hash: result.hash,
      ledger: result.ledger,
    });
  } catch (e: any) {
    const extras = e?.response?.data?.extras;
    return NextResponse.json(
      {
        ok: false,
        error: String(e?.message || e),
        result_xdr: extras?.result_xdr,
      },
      { status: 502 },
    );
  }
}
