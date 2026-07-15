import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const extraDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : [];

const allowedDevOrigins = ["127.0.0.1", ...extraDevOrigins];

const nextConfig: NextConfig = {
  allowedDevOrigins,
  output: "standalone",
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
};

const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins: ["remark-gfm"],
  },
});

export default withMDX(nextConfig);
