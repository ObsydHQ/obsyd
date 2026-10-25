import { NextResponse } from "next/server";

// The custody boundary, in one place.
//
// Obsyd's API builds transactions and relays envelopes; it never signs anything,
// because the keys belong on the device. That only holds if no endpoint can be
// *handed* a key — so every route that reads a request body runs it through
// `refuse` below before acting on it.

/** The only fields any Obsyd endpoint reads from a request body. */
const ALLOWED_FIELDS = new Set(["from", "to", "amount", "address", "xdr"]);

/** An ed25519 secret seed: 56 base32 characters starting with `S`. */
const SECRET_SEED = /^S[A-Z2-7]{55}$/;

/**
 * Parse a JSON body, or return null when there is none.
 *
 * Callers must still pass the result to `refuse`: a body that fails to parse is
 * not a body that has been checked.
 */
export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Refuse a request the boundary does not allow: a field no endpoint reads, or a
 * value shaped like a signing key. Returns null when the request may proceed.
 *
 * A wallet that posts a secret gets a loud 400 instead of a silent success, so
 * the mistake surfaces on the device rather than in a server log.
 */
export function refuse(body: Record<string, unknown> | null): NextResponse | null {
  if (!body) return null;
  for (const [field, value] of Object.entries(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `unexpected field "${field}" — this endpoint takes ` +
            `${[...ALLOWED_FIELDS].join(", ")} and nothing else`,
        },
        { status: 400 },
      );
    }
    if (typeof value === "string" && SECRET_SEED.test(value.trim())) {
      return NextResponse.json(
        { ok: false, error: "signing happens on the device — never send a secret here" },
        { status: 400 },
      );
    }
  }
  return null;
}
