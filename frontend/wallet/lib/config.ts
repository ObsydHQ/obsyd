// Obsyd — Stellar network configuration (original implementation).
// Defaults to testnet. All values overridable via NEXT_PUBLIC_* env.

export type NetworkName = "testnet" | "public";

export const config = {
  network: (process.env.NEXT_PUBLIC_NETWORK || "testnet") as NetworkName,
  horizonUrl:
    process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org",
  sorobanRpcUrl:
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
  friendbotUrl:
    process.env.NEXT_PUBLIC_FRIENDBOT_URL ||
    "https://friendbot.stellar.org",
};

export const networkPassphrase =
  config.network === "public"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

/** Validate a Stellar account address (G… for accounts, M… for muxed). */
export function looksLikeStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr.trim());
}
