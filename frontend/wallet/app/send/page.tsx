"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Transaction } from "@stellar/stellar-sdk";
import { WalletFrame } from "@/components/WalletFrame";
import { IconSend, IconKey } from "@/components/Icons";
import { localSigner, savedAddress } from "@/lib/wallet";
import { NETWORK_PASSPHRASE } from "@/lib/soroban";

export default function Send() {
  const [address, setAddress] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<"idle" | "waiting" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setAddress(savedAddress());
    setHasKey(!!localSigner());
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
    const signer = localSigner();
    if (!signer) {
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
      // 1. Ask the server for an unsigned payment.
      const r = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: address, to, amount }),
      });
      const built = await r.json();
      if (!built.ok) throw new Error(built.error || "could not build the transaction");

      // 2. Sign it here. The key never leaves this device.
      const tx = new Transaction(built.xdr, NETWORK_PASSPHRASE);
      tx.sign(signer);

      // 3. Hand the signed envelope to the relay.
      const s = await fetch("/api/tx/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ xdr: tx.toXDR() }),
      });
      const j = await s.json();
      if (!j.ok) throw new Error(describeSubmitFailure(j));

      setState("done");
      setMsg(j.hash);
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

        <p className="o-muted" style={{ fontSize: "0.74rem", display: "flex", gap: 6, alignItems: "center" }}>
          <IconSend width={13} height={13} />
          Built unsigned by the API, signed on this device.
        </p>

        {state === "done" && (
          <div className="o-card" style={{ borderLeft: "3px solid var(--good)" }}>
            <div style={{ fontWeight: 700 }}>Payment confirmed</div>
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
        {!hasKey ? (
          <p className="o-muted" style={{ fontSize: "0.78rem" }}>
            Tip: load a funded demo wallet on <Link href="/dashboard" style={{ color: "var(--accent-hi)" }}>Home</Link> to enable real testnet sends.
          </p>
        ) : null}
      </form>
    </WalletFrame>
  );
}

/** Horizon rejects a signed envelope with machine codes; show the useful one. */
function describeSubmitFailure(j: any): string {
  const codes = j?.result_codes;
  if (codes?.source === "tx_bad_seq") return "stale transaction (sequence moved) — try again";
  if (codes?.source === "tx_insufficient_balance") return "not enough XLM";
  return j?.error || "send failed";
}

function short(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
