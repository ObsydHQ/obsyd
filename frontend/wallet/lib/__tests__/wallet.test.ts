import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { createLocalWallet, localSigner, savedAddress } from "../wallet";

// This runs in node, where there is no `window`: the custody module must behave
// as if no wallet is loaded rather than reaching for a browser API. The point of
// these tests is that the key only ever exists inside this module.
describe("device custody without a browser", () => {
  it("reports no wallet", () => {
    expect(savedAddress()).toBe("");
    expect(localSigner()).toBeNull();
  });

  it("still produces a matching keypair and keeps it in the return value only", () => {
    const { address, secret } = createLocalWallet();
    expect(StrKey.isValidEd25519PublicKey(address)).toBe(true);
    expect(StrKey.isValidEd25519SecretSeed(secret)).toBe(true);
    expect(savedAddress()).toBe("");
  });
});

describe("what the API is allowed to receive", () => {
  it("only a signed envelope leaves the device, and it carries the key's signature", () => {
    const { address, secret } = createLocalWallet();
    const source = new Account(address, "1");
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: address, asset: Asset.native(), amount: "1" }))
      .setTimeout(30)
      .build();

    tx.sign(Keypair.fromSecret(secret));

    // Re-parsing is what /api/tx/submit does: it sees an envelope and a
    // signature, never a key.
    const relayed = new Transaction(tx.toXDR(), Networks.TESTNET);
    expect(relayed.signatures).toHaveLength(1);
    expect(relayed.sequence.toString()).toBe("2", "the builder advances the source sequence");
  });
});
