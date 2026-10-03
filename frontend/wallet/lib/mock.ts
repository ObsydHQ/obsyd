export type Asset = {
  code: string;
  name: string;
  amount: string;
  usd: string;
  color: string;
};

export const mockWallet = {
  addressShort: "GASTX…9F3K",
  addressFull:
    "GASTX7B4RQZ6MVG6Y2LH4XJ3KQFDOBSYDDEMO7F3K2N4P5Q6R7S8T9F3K",
  totalUsd: "1,284.60",
  changePct: "+3.2%",
};

export const assets: Asset[] = [
  { code: "XLM", name: "Lumens", amount: "3,910.24", usd: "512.30", color: "#5e8cff" },
  { code: "USDC", name: "USD Coin", amount: "640.00", usd: "640.00", color: "#2b6bff" },
  { code: "yXLM", name: "Stellar Yield", amount: "112.5", usd: "118.90", color: "#22d39a" },
  { code: "CLEDLR", name: "Celo Dollar", amount: "13.4", usd: "13.40", color: "#7f8ca0" },
];

export type Activity = {
  id: string;
  kind: "in" | "out" | "swap";
  title: string;
  sub: string;
  amount: string;
  usd: string;
  when: string;
};

export const activity: Activity[] = [
  { id: "1", kind: "in", title: "Received USDC", sub: "from GASTX…2A7", amount: "+240.00", usd: "$240.00", when: "2h ago" },
  { id: "2", kind: "swap", title: "Swap XLM → USDC", sub: "SoroSwap", amount: "−500 XLM", usd: "$65.40", when: "Yesterday" },
  { id: "3", kind: "out", title: "Sent XLM", sub: "to GCX4D…9K1", amount: "−120 XLM", usd: "$15.70", when: "Mon" },
  { id: "4", kind: "in", title: "Received XLM", sub: "airdrop", amount: "+50 XLM", usd: "$6.50", when: "Last week" },
];

export type Contact = {
  id: string;
  name: string;
  address: string;
  memo?: string;
};

export const contacts: Contact[] = [
  { id: "c1", name: "Ada", address: "GDXKA…7Q2", memo: "designer" },
  { id: "c2", name: "Linus", address: "G7HJK…B3Z", memo: "core dev" },
  { id: "c3", name: "Grace", address: "GZP9Q…4M1", memo: "ops" },
  { id: "c4", name: "Alan", address: "G5TTR…8W0" },
];
