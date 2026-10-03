// Obsyd — Stellar testnet data layer (original). Server-side; used by API routes.
import { Horizon, Networks, StrKey } from "@stellar/stellar-sdk";
import { config } from "./config";

const server = new Horizon.Server(config.horizonUrl, { allowHttp: false });

export type ObsydBalance = {
  code: string; // XLM | asset code
  type: "native" | "credit";
  amount: string;
  issuer?: string;
  asset?: string;
};

export type ObsydActivity = {
  id: string;
  kind: "in" | "out" | "other";
  title: string;
  sub: string;
  amount: string;
  when: string;
};

export function isValidStellarAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address.trim());
  } catch {
    return false;
  }
}

/** Load all classic balances (native XLM + trustlined assets) for an account. */
export async function fetchBalances(address: string): Promise<ObsydBalance[]> {
  const account = await server.loadAccount(address.trim());
  // SDK exposes balances either as a method or a plain array depending on version.
  const raw: any =
    typeof (account as any).balances === "function"
      ? (account as any).balances()
      : (account as any).balances;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((b: any): ObsydBalance => {
    if (b.asset_type === "native") {
      return { code: "XLM", type: "native", amount: b.balance };
    }
    // credit_alphanum4 / credit_alphanum12
    return {
      code: b.asset_code,
      type: "credit",
      amount: b.balance,
      issuer: b.asset_issuer,
      asset: b.asset,
    };
  });
}

/** Recent operations mapped to a lightweight activity feed. */
export async function fetchActivity(
  address: string,
  limit = 8,
): Promise<ObsydActivity[]> {
  const page = await server
    .operations()
    .forAccount(address.trim())
    .limit(limit)
    .order("desc")
    .call();
  const ops: Horizon.ServerApi.OperationRecord[] = page.records;

  return ops.map((op: any) => {
    const fromSelf = op.account === address.trim() || op.source === address.trim();
    const type = String(op.type);
    const amount =
      op.amount != null
        ? `${fromSelf && type.includes("payment") ? "−" : "+"}${op.amount}`
        : type;
    const asset = op.asset_type === "native" ? "XLM" : op.asset_code || "";
    const kind: ObsydActivity["kind"] =
      type === "create_account" && !fromSelf
        ? "in"
        : type.includes("payment")
          ? fromSelf
            ? "out"
            : "in"
          : "other";
    return {
      id: op.id,
      kind,
      title:
        type === "manage_buy_offer" || type === "path_payment_strict_receive"
          ? "Swap / path payment"
          : type.replace(/_/g, " "),
      sub: (op.from || op.source || "").slice(0, 6) + "…" + (op.to || "").slice(-4),
      amount: op.amount != null ? `${amount} ${asset}`.trim() : type,
      when: relTime(op.created_at),
    };
  });
}

export async function fundTestnet(address: string): Promise<boolean> {
  try {
    const base =
      config.friendbotUrl || "https://friendbot.stellar.org";
    const sep = base.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${sep}addr=${encodeURIComponent(address.trim())}`, {
      method: "GET",
    });
    return res.ok;
  } catch {
    return false;
  }
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const networkPassphrase =
  config.network === "public" ? Networks.PUBLIC : Networks.TESTNET;
