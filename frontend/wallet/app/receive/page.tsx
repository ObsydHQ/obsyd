"use client";

import { useEffect, useState } from "react";
import { WalletFrame } from "@/components/WalletFrame";
import { loadIdentity } from "@/lib/passkey";

export default function Receive() {
  const [identity, setIdentity] = useState("");
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setIdentity(loadIdentity()?.identity || "");
    setAddress(localStorage.getItem("obsyd.address") || "");
  }, []);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  return (
    <WalletFrame title="Receive">
      <section className="o-card" style={{ display: "grid", gap: 20, textAlign: "center" }}>
        {/* QR placeholder */}
        <div style={{ width: 190, height: 190, borderRadius: 20, background: "var(--bg-2)", boxShadow: "var(--shadow-inset)", display: "grid", placeItems: "center", color: "var(--text-faint)", fontSize: "0.8rem", margin: "0 auto" }}>
          QR
        </div>

        <div style={{ textAlign: "left" }}>
          <div className="o-label" style={{ marginBottom: 8 }}>Smart-wallet identity (passkey-derived)</div>
          <div className="o-card-inset o-mono" style={{ wordBreak: "break-all", fontSize: "0.82rem" }}>
            {identity || "Register a passkey in Settings to derive this"}
          </div>
        </div>

        <div style={{ textAlign: "left" }}>
          <div className="o-label" style={{ marginBottom: 8 }}>Receiving address (testnet account)</div>
          <div className="o-card-inset o-mono" style={{ wordBreak: "break-all", fontSize: "0.82rem" }}>
            {address || "Load a demo wallet on Home to get a fundable address"}
          </div>
          {address ? (
            <button className="o-btn o-btn-block" style={{ marginTop: 12 }} onClick={() => copy(address)}>
              {copied ? "Copied ✓" : "Copy address"}
            </button>
          ) : null}
        </div>

        <p className="o-muted" style={{ fontSize: "0.76rem" }}>
          The identity is bound to your passkey key; the receiving address is the live testnet account.
          Binding the two on-chain (factory deploy) is the next phase.
        </p>
      </section>
    </WalletFrame>
  );
}
