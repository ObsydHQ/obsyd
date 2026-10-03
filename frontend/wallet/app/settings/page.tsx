import Link from "next/link";
import { WalletFrame } from "@/components/WalletFrame";
import { IconKey, IconShield, IconSettings, IconHome } from "@/components/Icons";

export default function Settings() {
  return (
    <WalletFrame title="Settings">
      <div className="o-stack" style={{ gap: 12 }}>
        <Row href="/settings/passkeys" Icon={IconKey} title="Passkeys &amp; signers" sub="Register, rename, remove" />
        <Row href="/recover" Icon={IconShield} title="Recovery" sub="Guardians &amp; restore" />
        <Row href="/settings/security" Icon={IconSettings} title="Security" sub="Session lock, limits" />
        <Row href="/settings/network" Icon={IconHome} title="Network" sub="Testnet (current)" />
      </div>

      <div className="o-card" style={{ marginTop: 24, textAlign: "center" }}>
        <div className="o-label">Obsyd</div>
        <div className="o-muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>
          v0.1.0 · open-source · MIT · Stellar Soroban
        </div>
      </div>
    </WalletFrame>
  );
}

function Row({ href, Icon, title, sub }: { href: string; Icon: any; title: string; sub: string }) {
  return (
    <Link href={href}>
      <div className="o-card o-card-hover" style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 18px" }}>
        <span style={{ width: 40, height: 40, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--bg-2)", boxShadow: "var(--shadow-inset-sm)", color: "var(--accent-hi)" }}>
          <Icon width={18} height={18} />
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }} dangerouslySetInnerHTML={{ __html: title }} />
          <div className="o-muted" style={{ fontSize: "0.8rem" }} dangerouslySetInnerHTML={{ __html: sub }} />
        </div>
        <span className="o-muted">›</span>
      </div>
    </Link>
  );
}
