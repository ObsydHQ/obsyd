import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { publicPool, type PoolConfig } from "../swap";
import { refuse } from "../custody";

// The custody boundary.
//
// Obsyd's API builds transactions and relays envelopes; it never signs anything,
// because keys belong on the device. That is only true if (a) no request the app
// makes can carry a private key and (b) no route can act on one if it arrives.
// Both are properties of the source, so this file reads the source. Every scan
// runs against a planted fixture first: an analyzer that finds nothing in the
// real code only means something once it has proved it can find something.

function sources(...dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__" || entry === "node_modules" || entry.startsWith(".")) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry)) found.push(p);
    }
  };
  for (const dir of dirs) walk(dir);
  return found;
}

const appFiles = () => sources("app", "lib", "components");
const routeFiles = () => appFiles().filter((f) => f.includes(join("api", "route.ts")));

/** Index of the paren closing the one at `open`, or -1. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The arguments of every `fetch(...)` call in a source file. */
function fetchArgs(src: string): string[] {
  const calls: string[] = [];
  let at = 0;
  for (;;) {
    const start = src.indexOf("fetch(", at);
    if (start === -1) return calls;
    const end = closeParen(src, start + "fetch".length);
    if (end === -1) return calls;
    calls.push(src.slice(start + "fetch(".length, end));
    at = end;
  }
}

/** The object literal a call serialises as its body, or null for a GET. */
function sentBody(args: string): string | null {
  const at = args.indexOf("JSON.stringify(");
  if (at === -1) return null;
  const open = at + "JSON.stringify".length;
  const end = closeParen(args, open);
  return end === -1 ? null : args.slice(open + 1, end);
}

/** Top-level property names of an object literal, shorthand included. */
function bodyKeys(literal: string): string[] {
  let text = literal.trim();
  if (text.startsWith("{") && text.endsWith("}")) text = text.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of text) {
    if ("[{(".includes(c)) depth++;
    else if ("]})".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts
    .map((p) => p.match(/^\s*(?:\.\.\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|$)/)?.[1])
    .filter((k): k is string => !!k);
}

/** The `/api/...` path a call targets, or null when it is not one of ours. */
function endpointOf(args: string): string | null {
  return args.match(/["'`]([/]api[/a-z0-9-]*)/)?.[1] ?? null;
}

const SECRET_SEED = /S[A-Z2-7]{55}/;

describe("what leaves the device", () => {
  it("the scanner finds a key when one is planted", () => {
    const planted = `
      const secret = leak();
      await fetch("/api/evil", { method: "POST", body: JSON.stringify({ address, secret }) });
    `;
    const calls = fetchArgs(planted);
    expect(calls).toHaveLength(1);
    const body = sentBody(calls[0])!;
    expect(bodyKeys(body)).toEqual(["address", "secret"]);
    expect(endpointOf(calls[0])).toBe("/api/evil");
  });

  it("no request the app builds carries a private key", () => {
    const offenders: string[] = [];
    for (const file of appFiles()) {
      for (const args of fetchArgs(readFileSync(file, "utf8"))) {
        const body = sentBody(args);
        if (!body) continue;
        const keyed = bodyKeys(body).filter((k) => /secret|private/i.test(k));
        if (keyed.length) offenders.push(`${file} sends ${keyed.join(", ")}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // The whole API surface as one table: a new endpoint, or a new field on an
  // existing one, has to be added here on purpose. That is the review.
  it("the app sends exactly the documented bodies", () => {
    const sent: Record<string, string[]> = {};
    for (const file of appFiles()) {
      for (const args of fetchArgs(readFileSync(file, "utf8"))) {
        const path = endpointOf(args);
        if (!path) continue;
        const method = args.includes('method: "POST"') ? "POST" : "GET";
        const body = sentBody(args);
        sent[`${method} ${path}`] = (sent[`${method} ${path}`] || []).concat(body ? bodyKeys(body) : []);
      }
    }
    expect(sent).toEqual({
      "POST /api/fund": ["address"],
      "GET /api/balance": [],
      "POST /api/send": ["from", "to", "amount"],
      "POST /api/tx/submit": ["xdr"],
      "GET /api/swap/quote": [],
      "POST /api/swap/faucet": ["address"],
    });
  });
});

describe("what the API accepts", () => {
  it("refuse() rejects an unknown field and a secret in the allowed ones", () => {
    // Positive fixtures for the guard itself: it must not be a no-op.
    // Any unexpected field is refused, whatever its value holds.
    expect(refuse({ address: "GABC", secret: "S".repeat(56) })).not.toBeNull();
    expect(refuse({ xdr: "AAA", memo: "hi" })).not.toBeNull();
    // A seed-shaped value inside a field the endpoint DOES read is the case that
    // matters: without the shape check the route would use `address`, ignore the
    // key, and say nothing — a silent accept is what a custody boundary can't do.
    expect(refuse({ address: "S".repeat(56) })).not.toBeNull();
    expect(refuse({ from: "SA" + "B".repeat(54), to: "GDEF", amount: "1" })).not.toBeNull();
    expect(refuse({ from: "GABC", to: "GDEF", amount: "1" })).toBeNull();
    expect(refuse(null)).toBeNull();
  });

  it("no route signs with a caller-supplied key", () => {
    const planted = `Keypair.fromSecret(body.secret)`;
    expect(/fromSecret\(\s*(?:body|req)\b/.test(planted)).toBe(true);

    const signing: string[] = [];
    for (const file of routeFiles()) {
      if (/fromSecret\(\s*(?:body|req)\b/.test(readFileSync(file, "utf8"))) signing.push(file);
    }
    expect(signing, signing.join("\n")).toEqual([]);
  });

  it("every route that reads a body runs it through the boundary", () => {
    const unguarded: string[] = [];
    for (const file of routeFiles()) {
      const src = readFileSync(file, "utf8");
      // A route that never parses a request body cannot be handed a key.
      if (!src.includes("req.json()") && !src.includes("readBody(")) continue;
      if (!src.includes("refuse(")) unguarded.push(file);
      if (!src.includes("from \"@/lib/custody\"")) unguarded.push(`${file} (no custody import)`);
    }
    expect(unguarded, unguarded.join("\n")).toEqual([]);
  });

  it("the pool config shared with a browser has no treasury half", () => {
    const A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const pool: PoolConfig = {
      treasury: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH",
      treasurySecret: "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH",
      A,
      B,
      pair: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      decimals: 7,
      symbols: { OBA: A, OBB: B },
    };
    const shared = publicPool(pool);
    expect(Object.keys(shared).sort()).toEqual(["A", "B", "decimals", "pair", "symbols"]);
    expect(JSON.stringify(shared)).not.toMatch(SECRET_SEED);
  });
});

describe("who does the signing", () => {
  it("the payment envelope is signed on the device before the relay sees it", () => {
    const src = readFileSync(join("app", "send", "page.tsx"), "utf8");
    expect(src).toContain("localSigner()");
    // Ordering matters: a signature applied after the submit call would be decorative.
    expect(src.indexOf("tx.sign(signer)")).toBeGreaterThan(src.indexOf('"/api/send"'));
    expect(src.indexOf("tx.sign(signer)")).toBeLessThan(src.indexOf('"/api/tx/submit"'));
  });

  it("the swap is built and signed against the RPC, not the relay", () => {
    const src = readFileSync(join("app", "swap", "page.tsx"), "utf8");
    expect(src).toContain("swapExactTokens(signer");
    expect(src).not.toContain("/api/tx/submit");
    for (const args of fetchArgs(src)) expect(sentBody(args) ?? "").not.toMatch(SECRET_SEED);
  });

  it("the demo treasury config stays out of git", () => {
    const ignored = readFileSync(join("..", "..", ".gitignore"), "utf8");
    expect(ignored).toMatch(/frontend\/wallet\/scripts\/pool\.json/);
  });
});
