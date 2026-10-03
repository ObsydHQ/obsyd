"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WalletFrame } from "@/components/WalletFrame";
import { IconSwap } from "@/components/Icons";

type Token = { code: string; contract: string; balance: string };
type Quote = {
  amountIn: string;
  amountOut: string;
  rate: string;
  minOut: string;
  reserves: [string, string];
  priceImpactPct: string;
  route: string;
};

const TOKENS: Token[] = [
  { code: "OBA", contract: "", balance: "0" },
  { code: "OBB", contract: "", balance: "0" },
];

export default function Swap() {
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const [tokens, setTokens] = useState<Token[]>(TOKENS);
  const [from, setFrom] = useState("OBA");
  const [to, setTo] = useState("OBB");
  const [amt, setAmt] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<"idle" | "swapping" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [funding, setFunding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAddress(localStorage.getItem("obsyd.address") || "");
    setSecret(localStorage.getItem("obsyd.secret") || "");
  }, []);

  const balFor = useCallback(
    (code: string) => tokens.find((t) => t.code === code)?.balance ?? "0",
    [tokens],
  );

  // Debounced live quote from the real Soroswap pool.
  useEffect(() => {
    if (!address) return;
    if (!amt || Number(amt) <= 0 || from === to) {
      setQuote(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setQuoting(true);
    timer.current = setTimeout(async () => {
      try {
        const q = encodeURIComponent;
        const r = await fetch(
          `/api/swap/quote?from=${q(from)}&to=${q(to)}&amount=${q(amt)}&address=${q(address)}`,
        );
        const j = await r.json();
        if (j.ok) {
          setQuote(j.quote);
          setTokens(j.tokens);
        } else {
          setQuote(null);
          setMsg(j.error || "quote failed");
        }
      } catch {
        setQuote(null);
      } finally {
        setQuoting(false);
      }
    }, 450);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [amt, from, to, address]);

  const flip = () => {
    setFrom(to);
    setTo(from);
  };

  const faucet = async () => {
    if (!address) {
      setStatus("error");
      setMsg("Load a demo wallet from Home first.");
      return;
    }
    setFunding(true);
    setMsg("");
    try {
      const r = await fetch("/api/swap/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const j = await r.json();
      if (j.ok) {
        setMsg(`Faucet sent ${j.sent.OBA} OBA + ${j.sent.OBB} OBB.`);
        setTokens((prev) =>
          prev.map((t) =>
            t.code === "OBA" ? { ...t, balance: j.sent.OBA } : t.code === "OBB" ? { ...t, balance: j.sent.OBB } : t,
          ),
        );
      } else {
        setMsg(j.error || "faucet failed");
      }
    } catch (e: any) {
      setMsg(String(e?.message || e));
    } finally {
      setFunding(false);
    }
  };

  const execute = async () => {
    if (!secret) {
      setStatus("error");
      setMsg("No funded testnet wallet loaded. Go to Home → “Load demo wallet”.");
      return;
    }
    if (!quote) return;
    setStatus("swapping");
    setMsg("");
    try {
      const r = await fetch("/api/swap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, to, amount: amt, secret }),
      });
      const j = await r.json();
      if (j.ok) {
        setStatus("done");
        setMsg(j.hash);
        setAmt("");
        setQuote(null);
      } else {
        setStatus("error");
        setMsg(j.error || "swap failed");
      }
    } catch (e: any) {
      setStatus("error");
      setMsg(String(e?.message || e));
    }
  };

  const maxIn = Number(balFor(from)) || 0;
  const overBalance = amt && Number(amt) > maxIn;

  return (
    <WalletFrame title="Swap">
      <div className="o-stack">
        {!address ? (
          <div className="o-card-inset" style={{ color: "var(--o-muted)", fontSize: "0.85rem" }}>
            No wallet loaded. Open Home → “Load demo wallet” to get a funded testnet account.
          </div>
        ) : null}

        <TokenField
          label="You pay"
          code={from}
          onCode={setFrom}
          amount={amt}
          onAmount={setAmt}
          balance={balFor(from)}
          otherCode={to}
        />

        <div style={{ display: "grid", placeItems: "center", margin: "-10px 0" }}>
          <button
            className="o-btn"
            onClick={flip}
            style={{ padding: 12, borderRadius: "50%" }}
            aria-label="Flip"
          >
            <IconSwap width={18} height={18} style={{ transform: "rotate(90deg)" }} />
          </button>
        </div>

        <TokenField
          label="You receive"
          code={to}
          onCode={setTo}
          amount={quote ? quote.amountOut : "0.00"}
          onAmount={() => {}}
          readOnly
          balance={balFor(to)}
          otherCode={from}
        />

        {quoting && amt ? (
          <div className="o-card-inset o-between">
            <span className="o-muted" style={{ fontSize: "0.85rem" }}>Quoting from pool…</span>
            <span className="o-mono" style={{ fontSize: "0.85rem" }}>Soroswap</span>
          </div>
        ) : quote ? (
          <>
            <div className="o-card-inset o-between">
              <span className="o-muted" style={{ fontSize: "0.85rem" }}>Rate</span>
              <span className="o-mono" style={{ fontSize: "0.85rem" }}>
                1 {from} ≈ {quote.rate} {to}
              </span>
            </div>
            <div className="o-card-inset o-between">
              <span className="o-muted" style={{ fontSize: "0.85rem" }}>Route</span>
              <span className="o-mono" style={{ fontSize: "0.85rem" }}>{quote.route} · direct</span>
            </div>
            <div className="o-card-inset o-between">
              <span className="o-muted" style={{ fontSize: "0.85rem" }}>Min received</span>
              <span className="o-mono" style={{ fontSize: "0.85rem" }}>{quote.minOut} {to}</span>
            </div>
            <div className="o-card-inset o-between">
              <span className="o-muted" style={{ fontSize: "0.85rem" }}>Price impact</span>
              <span className="o-mono" style={{ fontSize: "0.85rem" }}>{quote.priceImpactPct}%</span>
            </div>
            <div className="o-card-inset o-between">
              <span className="o-muted" style={{ fontSize: "0.85rem" }}>Pool liquidity</span>
              <span className="o-mono" style={{ fontSize: "0.85rem" }}>
                {quote.reserves[0]} / {quote.reserves[1]}
              </span>
            </div>
          </>
        ) : null}

        <div style={{ display: "grid", gap: 10 }}>
          <button
            className="o-btn o-btn-primary o-btn-block"
            disabled={!quote || overBalance || status === "swapping"}
            onClick={execute}
            style={{ opacity: quote && !overBalance ? 1 : 0.5 }}
          >
            {status === "swapping" ? "Swapping on-chain…" : overBalance ? "Amount exceeds balance" : "Swap on Soroswap"}
          </button>
          <button
            className="o-btn o-btn-block"
            disabled={funding}
            onClick={faucet}
            style={{ opacity: funding ? 0.6 : 1 }}
          >
            {funding ? "Funding…" : "Get test tokens (OBA + OBB)"}
          </button>
        </div>

        {msg ? (
          <div className="o-card-inset" style={{ fontSize: "0.82rem", wordBreak: "break-all" }}>
            <span className={status === "done" ? "o-mono" : "o-muted"}>
              {status === "done" ? "Swap confirmed · tx: " : status === "error" ? "⚠ " : ""}
              {shortTx(msg)}
            </span>
            {status === "done" ? (
              <a
                className="o-mono"
                style={{ display: "block", marginTop: 6, fontSize: "0.78rem", color: "var(--o-accent)" }}
                target="_blank"
                rel="noreferrer"
                href={`https://stellar.expert/explorer/testnet/tx/${msg}`}
              >
                View on Stellar Expert ↗
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </WalletFrame>
  );
}

function shortTx(h: string) {
  return h.length > 24 ? `${h.slice(0, 14)}…${h.slice(-8)}` : h;
}

function TokenField({
  label,
  code,
  onCode,
  amount,
  onAmount,
  readOnly,
  balance,
  otherCode,
}: {
  label: string;
  code: string;
  onCode: (c: string) => void;
  amount: string;
  onAmount: (v: string) => void;
  readOnly?: boolean;
  balance: string;
  otherCode: string;
}) {
  return (
    <div className="o-card">
      <div className="o-between" style={{ marginBottom: 10 }}>
        <span className="o-label">{label}</span>
        <span className="o-muted" style={{ fontSize: "0.78rem" }}>
          bal: {balance}
        </span>
      </div>
      <div className="o-row" style={{ gap: 14 }}>
        <input
          className="o-input"
          style={{
            flex: 1,
            fontSize: "1.6rem",
            fontWeight: 800,
            boxShadow: "none",
            background: "transparent",
            padding: 0,
          }}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          readOnly={readOnly}
          onChange={(e) => onAmount(e.target.value)}
        />
        <select
          className="o-btn"
          value={code}
          onChange={(e) => onCode(e.target.value)}
          style={{ appearance: "none" }}
          disabled={readOnly}
        >
          {[code, otherCode].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
