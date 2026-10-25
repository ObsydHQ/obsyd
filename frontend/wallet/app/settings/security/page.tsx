import Link from "next/link";
import { WalletFrame } from "@/components/WalletFrame";

// What this build enforces, and what the wallet contract will enforce once it is
// deployed. A security screen that shows a protection the app does not implement
// is worse than a blank one: the user stops checking, and so does the reviewer.
export default function Security() {
  return (
    <WalletFrame title="Security">
      <div className="o-stack">
        <Row
          title="Step-up signing"
          sub="Passkey ceremony before any send is built"
          state="In force"
          live
        />
        <Row
          title="Keys stay on the device"
          sub="The API builds unsigned XDR and relays signed envelopes; lib/custody.ts refuses any other field"
          state="In force"
          live
        />
        <Row
          title="Inactivity lock"
          sub="Require a passkey after 5 minutes idle"
          state="Not implemented"
        />
        <Row
          title="Spend limit"
          sub="Per-token rolling cap — obsyd_account::set_spend_limit"
          state="Contract-side, not deployed"
        />

        <p className="o-muted" style={{ fontSize: "0.76rem" }}>
          The last two rows are features of the contract in
          <span className="o-mono"> contracts/obsyd_account</span>, which this app
          has not deployed yet. They are listed because they are the plan, not
          because they protect you today.
        </p>
        <Link href="/settings" className="o-btn o-btn-ghost">
          Back to settings
        </Link>
      </div>
    </WalletFrame>
  );
}

function Row({ title, sub, state, live }: { title: string; sub: string; state: string; live?: boolean }) {
  return (
    <div className="o-card o-between">
      <div>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div className="o-muted" style={{ fontSize: "0.8rem" }}>{sub}</div>
      </div>
      {live ? (
        <span className="o-pill">{state}</span>
      ) : (
        <span className="o-muted" style={{ fontSize: "0.76rem", textAlign: "right" }}>{state}</span>
      )}
    </div>
  );
}
