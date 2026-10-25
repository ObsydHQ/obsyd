/** @type {import('next').NextConfig} */

const dev = process.env.NODE_ENV !== "production";

// The origins Obsyd is willing to talk to. Anything else a script on this page
// tries to reach is blocked by the browser, not by us asking politely.
const peerOrigins = [
  process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org",
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
  process.env.NEXT_PUBLIC_FRIENDBOT_URL || "https://friendbot.stellar.org",
].map((u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}).filter(Boolean);

const csp = [
  "default-src 'self'",
  // Next ships inline bootstrap scripts and needs eval for its dev runtime; the
  // policy's job here is to refuse everything *remote*, not to be a purity test.
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // connect-src is the line that matters for a wallet: it bounds where a key that
  // lives in localStorage could be posted. Only our own API and the Stellar
  // endpoints named above are reachable.
  `connect-src 'self' ${peerOrigins.join(" ")}${dev ? " ws: wss:" : ""}`,
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Browsers ignore this directive in a report-only policy and log about it, and
  // a console that always has one warning is a console nobody reads.
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig = {
  reactStrictMode: true,
  // Tells an attacker which stack to probe before they even touch the app.
  poweredByHeader: false,
  // Dev serves the policy as Report-Only so a mistake shows up in the console
  // instead of silently breaking the wallet while you are working on it.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: dev ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy",
            value: csp,
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // The wallet needs WebAuthn, which no Permissions-Policy directive
          // gates; everything that could identify or track a user is closed.
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
