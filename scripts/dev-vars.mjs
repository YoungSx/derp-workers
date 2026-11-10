import { existsSync, writeFileSync } from "node:fs";

// The deterministic public test key (see README "Known limitations"). Local
// dev only — production must set a real DERP_SERVER_KEY Worker secret.
export const TEST_KEY_HEX = "0101010101010101010101010101010101010101010101010101010101010101";

export function ensureDevVars() {
  if (!existsSync(".dev.vars")) {
    writeFileSync(".dev.vars", `DERP_SERVER_KEY=${TEST_KEY_HEX}\n`);
  }
}
