import Link from "next/link";
import { WalletFrame } from "@/components/WalletFrame";

export default function Security() {
  return (
    <WalletFrame title="Security">
      <div className="o-stack">
        <div className="o-card o-between">
          <div><div style={{ fontWeight: 700 }}>Inactivity lock</div><div className="o-muted" style={{ fontSize: "0.8rem" }}>Require passkey after 5 min</div></div>
          <span className="o-pill">On</span>
        </div>
        <div className="o-card o-between">
          <div><div style={{ fontWeight: 700 }}>Spend limit</div><div className="o-muted" style={{ fontSize: "0.8rem" }}>Per-transaction cap</div></div>
          <span className="o-muted o-mono">500 XLM</span>
        </div>
        <div className="o-card o-between">
          <div><div style={{ fontWeight: 700 }}>Step-up signing</div><div className="o-muted" style={{ fontSize: "0.8rem" }}>Passkey for every send</div></div>
          <span className="o-pill">Required</span>
        </div>
        <Link href="/settings" className="o-btn o-btn-ghost">Back to settings</Link>
      </div>
    </WalletFrame>
  );
}
