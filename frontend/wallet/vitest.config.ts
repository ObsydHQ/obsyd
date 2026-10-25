import { defineConfig } from "vitest/config";

// The unit tests here are pure logic: amount parsing, quote math, WebAuthn
// structure parsing, address validation. Anything that needs a network belongs
// in the probe scripts, not in the suite.
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
