import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const extraDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : [];

const allowedDevOrigins = ["127.0.0.1", ...extraDevOrigins];

const configuredAgentWebSocketHost =
  process.env.AGENT_WS_HOSTNAME ?? "127.0.0.1";
const agentWebSocketHost = ["0.0.0.0", "::"].includes(
  configuredAgentWebSocketHost,
)
  ? "127.0.0.1"
  : configuredAgentWebSocketHost;
const agentWebSocketPort = process.env.AGENT_WS_PORT ?? "3091";

const nextConfig: NextConfig = {
  allowedDevOrigins,
  output: "standalone",
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
