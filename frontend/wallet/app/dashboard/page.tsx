"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { WalletFrame } from "@/components/WalletFrame";
import { IconSend, IconReceive, IconSwap, IconUsers } from "@/components/Icons";

type Bal = { code: string; type: string; amount: string; issuer?: string };
type Act = { id: string; kind: string; title: string; sub: string; amount: string; when: string };

const ADDR_KEY = "obsyd.address";

export default function Dashboard() {
  const [address, setAddress] = useState<string>("");
  const [balances, setBalances] = useState<Bal[]>([]);
  const [activity, setActivity] = useState<Act[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "empty" | "error">("idle");
  const [msg, setMsg] = useState("");

  const load = useCallback(async (addr: string) => {
    if (!addr) return;
    setStatus("loading");
    try {
      const r = await fetch(`/api/balance?address=${encodeURIComponent(addr)}`);
      const j = await r.json();
      if (j.ok) {
        setBalances(j.balances || []);
        setActivity(j.activity || []);
        setStatus("live");
        setMsg(j.network || "testnet");
      } else if (j.notFound) {
        setBalances([]);
        setActivity([]);
        setStatus("empty");
        setMsg("Account has no funds yet — load a demo wallet to fund one.");
      } else {
        setStatus("error");
        setMsg(j.error || "failed to load");
      }
    } catch (e: any) {
      setStatus("error");
      setMsg(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(ADDR_KEY) || "";
    if (saved) {
      setAddress(saved);
      load(saved);
    }
  }, [load]);

  const loadDemo = async () => {
    setStatus("loading");
    setMsg("");
    const r = await fetch("/api/demo");
    const j = await r.json();
    if (j.address) {
      localStorage.setItem(ADDR_KEY, j.address);
      if (j.secret) localStorage.setItem("obsyd.secret", j.secret);
      setAddress(j.address);
      load(j.address);
    } else {
      setStatus("error");
      setMsg(j.error || "could not create demo wallet");
    }
  };

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) return;
    localStorage.setItem(ADDR_KEY, address);
    load(address);
  };

  const xlm = balances.find((b) => b.code === "XLM");

  return (
    <WalletFrame>
      {/* Address / connect control */}
      <section className="o-card o-fade" style={{ padding: "16px 18px" }}>
        <div className="o-between" style={{ marginBottom: 10 }}>
          <span className="o-label">{status === "live" ? "Connected · " + msg : "Wallet"}</span>
          {address ? <span className="o-muted o-mono" style={{ fontSize: "0.78rem" }}>{short(address)}</span> : null}
        </div>
        <div className="o-row" style={{ gap: 10 }}>
          <button className="o-btn o-btn-primary" style={{ padding: "11px 18px" }} onClick={loadDemo}>
            Load demo wallet
          </button>
          <form onSubmit={connect} className="o-row" style={{ flex: 1, gap: 8 }}>
            <input
              className="o-input o-mono"
              placeholder="or paste G… address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              style={{ padding: "11px 14px", fontSize: "0.82rem" }}
            />
          </form>
        </div>
      </section>

      {/* Balance hero */}
      <section className="o-card o-fade o-fade-2" style={{ textAlign: "center", padding: "26px 22px", marginTop: 18 }}>
        <div className="o-label">Balance (testnet)</div>
        {status === "loading" ? (
          <div className="o-skeleton" style={{ width: 200, height: 52, margin: "12px auto 6px" }} />
        ) : (
          <div className="o-balance" style={{ margin: "10px 0 4px" }}>
            {status === "live" && xlm ? Number(xlm.amount).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
            <small>XLM</small>
          </div>
        )}
        {status === "live" ? (
          <div className="o-muted" style={{ fontSize: "0.82rem" }}>
            {balances.length} asset{balances.length === 1 ? "" : "s"} on-chain
          </div>
        ) : (
          <div className="o-muted" style={{ fontSize: "0.82rem", minHeight: 18 }}>{msg}</div>
        )}
      </section>

      {/* Quick actions */}
      <section className="o-grid o-fade o-fade-3" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginTop: 20 }}>
        <QuickTile href="/send" label="Send" Icon={IconSend} />
        <QuickTile href="/receive" label="Receive" Icon={IconReceive} />
        <QuickTile href="/swap" label="Swap" Icon={IconSwap} />
        <QuickTile href="/contacts" label="People" Icon={IconUsers} />
      </section>

      {/* Assets */}
      {balances.length > 0 && (
        <section className="o-fade o-fade-3" style={{ marginTop: 30 }}>
          <span className="o-label">Assets</span>
          <div className="o-stack" style={{ gap: 12, marginTop: 12 }}>
            {balances.map((b, i) => (
              <div key={b.code + i} className="o-card o-card-hover" style={{ display: "flex", justifyContent: "space-between", padding: "14px 18px" }}>
                <div className="o-row">
                  <span style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent-hi)", display: "grid", placeItems: "center", fontWeight: 800, fontSize: "0.7rem" }}>
                    {b.code.slice(0, 3)}
                  </span>
                  <div style={{ fontWeight: 700 }}>{b.code}</div>
                </div>
                <div className="o-mono" style={{ fontWeight: 700 }}>{Number(b.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Activity */}
      {activity.length > 0 ? (
        <section className="o-fade o-fade-4" style={{ marginTop: 30 }}>
          <span className="o-label">Recent activity</span>
          <div className="o-stack" style={{ gap: 10, marginTop: 12 }}>
            {activity.map((tx) => (
              <div key={tx.id} className="o-card" style={{ display: "flex", justifyContent: "space-between", padding: "14px 16px" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.92rem", textTransform: "capitalize" }}>{tx.title}</div>
                  <div className="o-muted" style={{ fontSize: "0.76rem" }}>{tx.sub} · {tx.when}</div>
                </div>
                <div className="o-mono" style={{ fontWeight: 700, color: tx.kind === "out" ? "var(--bad)" : tx.kind === "in" ? "var(--good)" : "var(--text)" }}>
                  {tx.amount}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {status === "idle" && !address ? (
        <p className="o-muted o-fade-4" style={{ fontSize: "0.8rem", marginTop: 24, textAlign: "center" }}>
          Tap “Load demo wallet” to create &amp; fund a real testnet account, or paste any Stellar address.
        </p>
      ) : null}
    </WalletFrame>
  );
}

function short(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function QuickTile({ href, label, Icon }: { href: string; label: string; Icon: any }) {
  return (
    <Link href={href}>
      <button className="o-tile" style={{ width: "100%" }}>
        <span className="o-tile-ico"><Icon width={20} height={20} /></span>
        <span style={{ fontSize: "0.78rem", fontWeight: 700 }}>{label}</span>
      </button>
    </Link>
  );
}
