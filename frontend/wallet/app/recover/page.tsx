"use client";

import { useState } from "react";
import Link from "next/link";
import { WalletFrame } from "@/components/WalletFrame";
import { IconShield } from "@/components/Icons";

export default function Recover() {
  const [addr, setAddr] = useState("");
  const [step, setStep] = useState<null | "found">(null);

  return (
    <WalletFrame title="Restore wallet">
      <div className="o-stack">
        <div className="o-card" style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span style={{ width: 42, height: 42, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent-hi)" }}>
            <IconShield width={20} height={20} />
          </span>
          <div className="o-muted" style={{ fontSize: "0.88rem" }}>
            Recover with the passkey already registered on this device, or via your
            guardians. There is no seed phrase to type.
          </div>
        </div>

        <label className="o-stack" style={{ gap: 8 }}>
          <span className="o-label">Wallet address</span>
          <input className="o-input o-mono" placeholder="G…" value={addr} onChange={(e) => setAddr(e.target.value)} />
        </label>

        <button className="o-btn o-btn-primary o-btn-block" onClick={() => addr && setStep("found")}>
          Verify passkey to restore
        </button>

        {step === "found" ? (
          <div className="o-card" style={{ borderLeft: "3px solid var(--good)" }}>
            <div style={{ fontWeight: 700 }}>Passkey recognized (mock)</div>
            <div className="o-muted" style={{ fontSize: "0.86rem", marginTop: 4 }}>
              On-chain signer verification runs in the integration phase.
            </div>
            <Link href="/dashboard" className="o-btn o-btn-block" style={{ marginTop: 12 }}>Go to dashboard</Link>
          </div>
        ) : null}
      </div>
    </WalletFrame>
  );
}
