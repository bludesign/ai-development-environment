import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/control-agent.js",
  banner: {
    js: `#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);`,
  },
});
