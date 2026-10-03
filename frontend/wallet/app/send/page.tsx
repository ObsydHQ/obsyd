"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { WalletFrame } from "@/components/WalletFrame";
import { IconSend, IconKey } from "@/components/Icons";

export default function Send() {
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<"idle" | "waiting" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setAddress(localStorage.getItem("obsyd.address") || "");
    setSecret(localStorage.getItem("obsyd.secret") || "");
  }, []);

  const challenge = () => crypto.getRandomValues(new Uint8Array(32));

  const passkeyStepUp = async (): Promise<boolean> => {
    if (!("credentials" in navigator)) throw new Error("WebAuthn unavailable");
    const res = await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        timeout: 60000,
        userVerification: "required",
        rpId: location.hostname,
      },
    });
    return !!res;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    if (!secret) {
      setState("error");
      setMsg("No funded testnet wallet loaded. Go to Home → “Load demo wallet” first.");
      return;
    }
    setState("waiting");
    try {
      await passkeyStepUp(); // genuine WebAuthn assertion gating the send
    } catch (err: any) {
      setState("error");
      setMsg(`Passkey step-up failed: ${err?.message || err}. Register one in Settings → Passkeys.`);
      return;
    }
    setState("sending");
    try {
      const r = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: address, to, amount, secret }),
      });
      const j = await r.json();
      if (j.ok) {
        setState("done");
        setMsg(j.hash);
      } else {
        setState("error");
        setMsg(j.error || "send failed");
      }
    } catch (err: any) {
      setState("error");
      setMsg(String(err?.message || err));
    }
  };

  return (
    <WalletFrame title="Send">
      <form className="o-stack" onSubmit={submit}>
        <div className="o-card-inset o-between">
          <span className="o-muted" style={{ fontSize: "0.82rem" }}>From</span>
          <span className="o-mono" style={{ fontSize: "0.82rem" }}>
            {address ? short(address) : "no wallet"}
          </span>
        </div>

        <label className="o-stack" style={{ gap: 8 }}>
          <span className="o-label">To — recipient address</span>
          <input className="o-input o-mono" placeholder="G…" value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>

        <label className="o-stack" style={{ gap: 8 }}>
          <span className="o-label">Amount (XLM)</span>
          <input className="o-input" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>

        <div className="o-card-inset o-between">
          <span className="o-muted" style={{ fontSize: "0.85rem" }}>Network fee</span>
          <span className="o-mono" style={{ fontSize: "0.85rem" }}>100 stroops</span>
        </div>

        <button type="submit" className="o-btn o-btn-primary o-btn-block" disabled={state === "sending" || state === "waiting"}>
          <IconKey width={16} height={16} />
          {state === "waiting" ? "Confirm passkey…" : state === "sending" ? "Signing & submitting…" : "Sign with passkey & send"}
        </button>

        {state === "done" && (
          <div className="o-card" style={{ borderLeft: "3px solid var(--good)" }}>
            <div style={{ fontWeight: 700 }}>Payment confirmed on testnet</div>
            <div className="o-muted o-mono" style={{ fontSize: "0.74rem", marginTop: 6, wordBreak: "break-all" }}>{msg}</div>
            <a className="o-btn o-btn-block" style={{ marginTop: 12 }} href={`https://stellar.expert/explorer/testnet/tx/${msg}`} target="_blank" rel="noreferrer">View on StellarExpert</a>
          </div>
        )}
        {state === "error" && (
          <div className="o-card" style={{ borderLeft: "3px solid var(--bad)" }}>
            <div style={{ fontWeight: 700 }}>Send failed</div>
            <div className="o-muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>{msg}</div>
          </div>
        )}
        {!secret ? (
          <p className="o-muted" style={{ fontSize: "0.78rem" }}>
            Tip: load a funded demo wallet on <Link href="/dashboard" style={{ color: "var(--accent-hi)" }}>Home</Link> to enable real testnet sends.
          </p>
        ) : null}
      </form>
    </WalletFrame>
  );
}

function short(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
