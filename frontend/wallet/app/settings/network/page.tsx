import Link from "next/link";
import { WalletFrame } from "@/components/WalletFrame";

export default function Network() {
  return (
    <WalletFrame title="Network">
      <div className="o-stack">
        <div className="o-card o-between" style={{ border: "1px solid var(--accent-soft)" }}>
          <div><div style={{ fontWeight: 700 }}>Testnet</div><div className="o-muted o-mono" style={{ fontSize: "0.74rem" }}>soroban-testnet.stellar.org</div></div>
          <span className="o-pill">Active</span>
        </div>
        <div className="o-card o-between">
          <div><div style={{ fontWeight: 700 }}>Mainnet</div><div className="o-muted o-mono" style={{ fontSize: "0.74rem" }}>pubnet</div></div>
          <span className="o-muted">Select</span>
        </div>
        <Link href="/settings" className="o-btn o-btn-ghost">Back to settings</Link>
      </div>
    </WalletFrame>
  );
}
