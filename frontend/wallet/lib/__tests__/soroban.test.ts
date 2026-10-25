import { describe, expect, it } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";
import {
  DECIMALS,
  FACTORY,
  ONE,
  ROUTER,
  fromUnits,
  i128,
  reserveFor,
  toUnits,
  u64,
  vecAddress,
} from "../soroban";

describe("amount units (7 decimals)", () => {
  it("parses whole and fractional amounts", () => {
    expect(DECIMALS).toBe(7);
    expect(toUnits("1")).toBe(ONE);
    expect(toUnits("0")).toBe(0n);
    expect(toUnits("12.345")).toBe(12n * ONE + 3_450_000n);
    expect(toUnits("0.0000001")).toBe(1n);
    expect(toUnits("  2.50  ")).toBe(25n * (ONE / 10n));
  });

  it("truncates precision the ledger cannot represent", () => {
    expect(toUnits("1.12345678")).toBe(11_234_567n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "   ", "abc", "-1", "1e3", "1.2.3", ".5", "1.", "0x10", "NaN"]) {
      expect(() => toUnits(bad), bad).toThrow();
    }
  });

  it("formats back to a trimmed decimal string", () => {
    expect(fromUnits(ONE)).toBe("1");
    expect(fromUnits("15000000")).toBe("1.5");
    expect(fromUnits(1n)).toBe("0.0000001");
    expect(fromUnits(-(2n * ONE + 5_000_000n))).toBe("-2.5");
  });

  it("round-trips the values the swap screen can produce", () => {
    for (const human of ["0.0000001", "1", "3.1415926", "1000", "99999.9999999"]) {
      expect(fromUnits(toUnits(human))).toBe(human);
    }
  });
});

describe("pair reserve lookup", () => {
  const token0 = ROUTER;
  const token1 = FACTORY;

  it("maps a token address to its own reserve", () => {
    const reserves = [100n * ONE, 200n * ONE];
    expect(reserveFor(reserves, token0, token1, token0)).toBe(100n * ONE);
    expect(reserveFor(reserves, token0, token1, token1)).toBe(200n * ONE);
  });

  it("is the inverse of the direction a swap is quoted in", () => {
    const r = [5n * ONE, 9n * ONE];
    const sold = reserveFor(r, token0, token1, token1);
    const bought = reserveFor(r, token0, token1, token0);
    expect([sold, bought]).toEqual([9n * ONE, 5n * ONE]);
  });
});

describe("scval encoding for router calls", () => {
  it("encodes i128 amounts losslessly", () => {
    const amount = 123_456_789_012_345_678n;
    expect(BigInt(scValToNative(i128(amount)) as unknown as string)).toBe(amount);
    expect(BigInt(scValToNative(i128(ONE)) as unknown as string)).toBe(ONE);
  });

  it("encodes a u64 deadline", () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    expect(BigInt(scValToNative(u64(deadline)) as unknown as string)).toBe(deadline);
  });

  it("encodes a two-hop path in order", () => {
    expect(scValToNative(vecAddress([ROUTER, FACTORY]))).toEqual([ROUTER, FACTORY]);
  });
});
