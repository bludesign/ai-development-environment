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
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
  async rewrites() {
    return [
      {
        source: "/graphql",
        destination: `http://${agentWebSocketHost}:${agentWebSocketPort}/graphql`,
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
