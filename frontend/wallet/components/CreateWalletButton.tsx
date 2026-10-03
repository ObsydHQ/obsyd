"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { registerPasskey } from "@/lib/passkey";
import { IconFingerprint } from "./Icons";

export function CreateWalletButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "waiting" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [identity, setIdentity] = useState("");

  const create = async () => {
    setMsg("");
    setState("waiting");
    try {
      const rec = await registerPasskey();
      setIdentity(rec.identity);
      // Give the biometric a beat to settle, then enter the wallet.
      setTimeout(() => router.push("/dashboard"), 900);
    } catch (e: any) {
      setState("error");
      setMsg(
        `${e?.name === "NotAllowedError" ? "Passkey prompt dismissed." : e?.message || e}` +
          ` — needs HTTPS or localhost, and a device passkey (Windows Hello / Touch ID).`,
      );
    }
  };

  return (
    <div className="o-stack" style={{ gap: 12 }}>
      <button className="o-btn o-btn-primary o-btn-block" onClick={create} disabled={state === "waiting"}>
        <IconFingerprint width={18} height={18} />
        {state === "waiting" ? "Confirm biometric…" : "Create a wallet"}
      </button>

      {identity ? (
        <div className="o-card" style={{ borderLeft: "3px solid var(--good)" }}>
          <div className="o-label">Your wallet identity (passkey-derived)</div>
          <div className="o-mono" style={{ fontSize: "0.8rem", marginTop: 6, wordBreak: "break-all" }}>
            {identity}
          </div>
          <div className="o-muted" style={{ fontSize: "0.76rem", marginTop: 6 }}>
            Entering wallet…
          </div>
        </div>
      ) : null}

      {state === "error" ? (
        <div className="o-card" style={{ borderLeft: "3px solid var(--bad)" }}>
          <div className="o-muted" style={{ fontSize: "0.82rem" }}>{msg}</div>
        </div>
      ) : null}
    </div>
  );
}
