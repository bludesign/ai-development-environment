import { parseOriginPattern, resolveAppOrigins } from "@/lib/app-origins";

export type McpOAuthConfig = {
  origin: string;
  issuer: string;
  resource: string;
  dcrEnabled: boolean;
};

function flag(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
) {
  const value = environment[name]?.trim().toLowerCase();
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new Error(`${name} must be true, false, 1, or 0.`);
}

export function getMcpOAuthConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): McpOAuthConfig | null {
  if (!flag(environment, "MCP_OAUTH_ENABLED")) return null;
  if (
    !environment.PUBLIC_BASE_URL?.trim() &&
    !environment.APP_ORIGINS?.trim()
  ) {
    throw new Error(
      "MCP OAuth requires a configured canonical PUBLIC_BASE_URL or APP_ORIGINS.",
    );
  }
  const origins = resolveAppOrigins(environment);
  const configured = environment.APP_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(parseOriginPattern)
    .find((pattern) => !pattern.wildcard);
  // Development's implicit localhost entries are useful for browser sign-in,
  // but must never silently become an OAuth issuer.
  const canonical = environment.PUBLIC_BASE_URL?.trim()
    ? origins.canonical
    : configured
      ? `${configured.protocol ?? (configured.loopback ? "http:" : "https:")}//${configured.host}`
      : null;
  if (!canonical)
    throw new Error("MCP OAuth requires an exact canonical origin.");
  const url = new URL(canonical);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "[::1]" ||
    /^127\./.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "MCP OAuth requires HTTPS except on loopback development origins.",
    );
  }
  return {
    origin: url.origin,
    issuer: `${url.origin}/api/auth`,
    resource: `${url.origin}/api/mcp`,
    dcrEnabled: flag(environment, "MCP_OAUTH_DCR_ENABLED"),
  };
}
