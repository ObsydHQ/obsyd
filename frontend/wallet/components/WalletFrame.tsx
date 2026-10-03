import Link from "next/link";
import { Nav } from "./Nav";
import { ObsydLogo } from "./ObsydLogo";

export function WalletFrame({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <main className="o-shell">
      <div className="o-topbar">
        <Link href="/dashboard">
          <ObsydLogo size={18} />
        </Link>
        <span className="o-pill">Testnet</span>
      </div>
      {title ? <h2 className="o-h1" style={{ marginBottom: 18 }}>{title}</h2> : null}
      {children}
      <Nav />
    </main>
  );
}
