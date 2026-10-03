import Link from "next/link";
import { ObsydLogo } from "@/components/ObsydLogo";
import { CreateWalletButton } from "@/components/CreateWalletButton";
import { IconFingerprint, IconShield } from "@/components/Icons";

export default function Onboarding() {
  return (
    <main className="o-shell" style={{ paddingTop: 40 }}>
      <div className="o-topbar o-fade">
        <ObsydLogo size={22} />
        <span className="o-pill">Testnet</span>
      </div>

      <div className="o-stack" style={{ gap: 30, marginTop: 24 }}>
        <div className="o-fade o-fade-2">
          <h1 className="o-display">
            Your passkey
            <br />
            is your wallet.
          </h1>
          <p className="o-muted" style={{ fontSize: "1.05rem", lineHeight: 1.5, maxWidth: "30ch" }}>
            No seed phrase. No password. Just your biometric — securing a smart
            contract wallet on <strong style={{ color: "var(--text)" }}>Stellar Soroban</strong>.
          </p>
        </div>

        <div className="o-card o-fade o-fade-3" style={{ display: "grid", gap: 14 }}>
          <div className="o-row">
            <span className="o-tile-ico">
              <IconFingerprint width={22} height={22} />
            </span>
            <div>
              <div className="o-h2">Passkey security</div>
              <div className="o-muted" style={{ fontSize: "0.9rem" }}>
                Face ID · fingerprint · Windows Hello
              </div>
            </div>
          </div>
          <div className="o-row">
            <span className="o-tile-ico">
              <IconShield width={22} height={22} />
            </span>
            <div>
              <div className="o-h2">Smart contract wallet</div>
              <div className="o-muted" style={{ fontSize: "0.9rem" }}>
                Recoverable. On-chain. Yours.
              </div>
            </div>
          </div>
        </div>

        <div className="o-stack o-fade o-fade-4" style={{ gap: 14 }}>
          <CreateWalletButton />
          <Link href="/recover" className="o-btn o-btn-block">
            Restore an existing wallet
          </Link>
        </div>

        <p className="o-muted" style={{ fontSize: "0.78rem", textAlign: "center" }}>
          Obsyd · open-source · MIT · Stellar Soroban
        </p>
      </div>
    </main>
  );
}
