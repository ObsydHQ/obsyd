"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconHome, IconSend, IconSwap, IconUsers, IconSettings } from "./Icons";

const items = [
  { href: "/dashboard", label: "Home", Icon: IconHome },
  { href: "/send", label: "Send", Icon: IconSend },
  { href: "/swap", label: "Swap", Icon: IconSwap },
  { href: "/contacts", label: "Contacts", Icon: IconUsers },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="o-nav o-fixednav">
      {items.map(({ href, label, Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link key={href} href={href} className={active ? "active" : ""}>
            <Icon width={20} height={20} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
