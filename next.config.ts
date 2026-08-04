import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { devServerOrigins, resolveAppOrigins } from "./src/lib/app-origins";

// The dev server's cross-origin allowlist is the same question APP_ORIGINS answers
// for the auth layer, so both read one list. Relative import: this file loads before
// the TypeScript path aliases resolve.
//
// Resolved with development semantics deliberately. `allowedDevOrigins` has no effect
// outside `next dev`, and this file is evaluated during `next build` before Next sets
// NEXT_PHASE — so asking for the production rules here would fail the build over a
// variable the build never uses.
const allowedDevOrigins = devServerOrigins(
  resolveAppOrigins({ ...process.env, NODE_ENV: "development" }),
);

const configuredAgentWebSocketHost =
  process.env.AGENT_WS_HOSTNAME ?? "127.0.0.1";
const agentWebSocketHost = ["0.0.0.0", "::"].includes(
  configuredAgentWebSocketHost,
)
  ? "127.0.0.1"
  : configuredAgentWebSocketHost;
const agentWebSocketPort = process.env.AGENT_WS_PORT ?? "3091";

// The on-demand screenshot build sets SCREENSHOT_DIST_DIR to an isolated output dir so it
// never clobbers the primary `.next` directory a dev server may be serving from. That build is
// a visual artifact, not a CI gate, so it also skips type-checking (the primary build still
// enforces it) to stay fast and resilient to unrelated app-wide issues.
//
// The name is deliberately screenshot-specific: a generic NEXT_DIST_DIR left in the
// environment would silently redirect `npm run build` and disable its type-checking too.
const screenshotDistDir =
  process.env.SCREENSHOT_DIST_DIR && process.env.SCREENSHOT_DIST_DIR !== ".next"
    ? process.env.SCREENSHOT_DIST_DIR
    : undefined;

const nextConfig: NextConfig = {
  allowedDevOrigins,
  output: "standalone",
  distDir: screenshotDistDir ?? ".next",
  typescript: { ignoreBuildErrors: !!screenshotDistDir },
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/@napi-rs/keyring/**/*",
      "node_modules/@napi-rs/keyring-darwin-*/**/*",
    ],
    "/api/telemetry/export": [
      "node_modules/@expo-google-fonts/noto-emoji/400Regular/NotoEmoji_400Regular.ttf",
      "node_modules/@fontpkg/unifont/unifont-15.0.01.ttf",
    ],
  },
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
  serverExternalPackages: ["@napi-rs/keyring", "pdfkit", "re2-wasm"],
  turbopack: {
    // Brand logos ship as SVG files (see @lobehub/icons-static-svg); SVGR turns
    // them into components so they inherit `currentColor` and Tailwind sizing.
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
  async rewrites() {
    return [
      {
        source: "/graphql",
        destination: `http://${agentWebSocketHost}:${agentWebSocketPort}/graphql`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'",
          },
        ],
      },
    ];
  },
};

const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins: ["remark-gfm"],
  },
});

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(withMDX(nextConfig));
