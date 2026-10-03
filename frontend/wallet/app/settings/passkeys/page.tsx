"use client";

import { useCallback, useEffect, useState } from "react";
import { WalletFrame } from "@/components/WalletFrame";
import { IconKey, IconFingerprint } from "@/components/Icons";
import { registerPasskey, loadIdentity, type RegisteredPasskey } from "@/lib/passkey";

export default function Passkeys() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [ident, setIdent] = useState<ReturnType<typeof loadIdentity>>(null);
  const [rec, setRec] = useState<RegisteredPasskey | null>(null);

  const refresh = useCallback(() => setIdent(loadIdentity()), []);
  useEffect(refresh, [refresh]);

  const register = async () => {
    setStatus("");
    setBusy(true);
    try {
      const r = await registerPasskey();
      setRec(r);
      setStatus(`Registered. P-256 pubkey ${r.publicKeyHex.slice(0, 10)}…${r.publicKeyHex.slice(-6)}`);
      refresh();
    } catch (e: any) {
      setStatus(`WebAuthn error: ${e?.message || e}. Needs HTTPS/localhost + device passkey.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WalletFrame title="Passkeys &amp; signers">
      <div className="o-stack">
        {ident?.identity ? (
          <div className="o-card">
            <div className="o-label">Wallet identity</div>
            <div className="o-mono" style={{ fontSize: "0.82rem", marginTop: 6, wordBreak: "break-all" }}>{ident.identity}</div>
            {ident.publicKeyHex ? (
              <div className="o-muted o-mono" style={{ fontSize: "0.7rem", marginTop: 6, wordBreak: "break-all" }}>
                pub {ident.publicKeyHex.slice(0, 22)}…{ident.publicKeyHex.slice(-8)}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="o-card-inset" style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>
            No passkey registered yet. Register one to derive your wallet identity.
          </div>
        )}

        <div className="o-card o-row" style={{ justifyContent: "space-between" }}>
          <div className="o-row">
            <span style={{ width: 40, height: 40, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent-hi)" }}>
              <IconFingerprint width={18} height={18} />
            </span>
            <div>
              <div style={{ fontWeight: 700 }}>{rec ? `Passkey ${(rec.credentialId || "").slice(0, 8)}…` : "This device"}</div>
              <div className="o-muted" style={{ fontSize: "0.75rem" }}>{typeof window !== "undefined" ? window.location.hostname : "obsyd"}</div>
            </div>
          </div>
          <span className="o-pill"><IconKey width={12} height={12} /> P-256</span>
        </div>

        <button className="o-btn o-btn-primary o-btn-block" onClick={register} disabled={busy}>
          {busy ? "Waiting for biometric…" : "Register a new passkey"}
        </button>
        {status ? (
          <div className="o-card-inset" style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>{status}</div>
        ) : null}
        <p className="o-muted" style={{ fontSize: "0.78rem" }}>
          This creates a real WebAuthn credential and derives your identity from its P-256 public key
          (SHA-256 → obsyd_…). On-chain deployment of that identity is the next, security-reviewed phase.
        </p>
      </div>
    </WalletFrame>
  );
}
