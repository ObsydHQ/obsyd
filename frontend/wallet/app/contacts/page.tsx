"use client";

import { useState } from "react";
import { WalletFrame } from "@/components/WalletFrame";
import { contacts as seed, type Contact } from "@/lib/mock";

export default function Contacts() {
  const [list, setList] = useState<Contact[]>(seed);
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [adding, setAdding] = useState(false);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !addr) return;
    setList([{ id: String(Date.now()), name, address: addr }, ...list]);
    setName("");
    setAddr("");
    setAdding(false);
  };

  return (
    <WalletFrame title="Contacts">
      <div className="o-row o-between" style={{ marginBottom: 16 }}>
        <span className="o-muted" style={{ fontSize: "0.85rem" }}>{list.length} saved</span>
        <button className="o-btn" style={{ padding: "10px 16px" }} onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      {adding ? (
        <form className="o-card o-stack" onSubmit={add} style={{ marginBottom: 18 }}>
          <input className="o-input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="o-input o-mono" placeholder="G… address" value={addr} onChange={(e) => setAddr(e.target.value)} />
          <button className="o-btn o-btn-primary o-btn-block" type="submit">Save contact</button>
        </form>
      ) : null}

      <div className="o-stack" style={{ gap: 12 }}>
        {list.map((c) => (
          <div key={c.id} className="o-card o-card-hover" style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px" }}>
            <span style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent-hi)", display: "grid", placeItems: "center", fontWeight: 800 }}>
              {c.name.slice(0, 1)}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{c.name}</div>
              <div className="o-muted o-mono" style={{ fontSize: "0.76rem" }}>{c.address}{c.memo ? ` · ${c.memo}` : ""}</div>
            </div>
          </div>
        ))}
      </div>
    </WalletFrame>
  );
}
