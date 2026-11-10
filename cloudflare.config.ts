import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "derp-workers",
    entrypoint: "src/index.js",
    compatibilityDate: "2026-11-09",
    exports: {
      DerpRegion: { type: "durable-object", storage: "sqlite" },
    },
  },
});
