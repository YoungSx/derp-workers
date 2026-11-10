import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    // DERP_WORKER_NAME lets CI deploy an isolated copy under a different name.
    name: process.env.DERP_WORKER_NAME ?? "derp-workers",
    entrypoint: "src/index.js",
    compatibilityDate: "2026-11-09",
    exports: {
      DerpRegion: { type: "durable-object", storage: "sqlite" },
    },
  },
});
