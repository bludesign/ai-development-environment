import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The GitHub runners are slow enough that tests which finish in well under a
    // second locally were tripping Vitest's 5s default and failing the workflow.
    // Matches the root config; everything else stays on Vitest's defaults.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
