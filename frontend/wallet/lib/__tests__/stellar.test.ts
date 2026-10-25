import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { isValidStellarAddress, networkPassphrase } from "../stellar";
import { config } from "../config";
import { looksLikeStellarAddress } from "../config";

describe("address validation", () => {
  it("accepts a real ed25519 account id", () => {
    expect(isValidStellarAddress(Keypair.random().publicKey())).toBe(true);
    expect(isValidStellarAddress("  " + Keypair.random().publicKey() + "  ")).toBe(true);
  });

  it("rejects junk, contracts and malformed checksums", () => {
    for (const bad of ["", "G", "not an address", "0x1234", "g".repeat(56)]) {
      expect(isValidStellarAddress(bad), bad).toBe(false);
    }
    // A contract id (C…) is a valid strkey but not an account.
    expect(isValidStellarAddress("CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD")).toBe(false);
  });
});

describe("network configuration", () => {
  it("is testnet unless told otherwise, and the passphrase follows it", () => {
    expect(["testnet", "public"]).toContain(config.network);
    expect(networkPassphrase).toBe(
      config.network === "public"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015",
    );
  });

  it("endpoints match the configured network", () => {
    const host = new URL(config.horizonUrl).hostname;
    if (config.network === "testnet") {
      expect(host).toContain("testnet");
      expect(new URL(config.sorobanRpcUrl).hostname).toContain("testnet");
    } else {
      expect(host).not.toContain("testnet");
    }
  });

  it("the strict address matcher is the 56-character G form", () => {
    expect(looksLikeStellarAddress(Keypair.random().publicKey())).toBe(true);
    expect(looksLikeStellarAddress("M" + "A".repeat(55))).toBe(false);
  });
});
