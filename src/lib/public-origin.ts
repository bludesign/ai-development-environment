export type PublicOrigin = {
  /** Absolute origin with no trailing slash, for example `https://builds.example.com`. */
  origin: string;
  secure: boolean;
  loopback: boolean;
  source: "env" | "forwarded" | "host";
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]", "0.0.0.0"]);

/**
 * Rejects hosts that could break out of the URL they get interpolated into.
 * The resolved origin ends up inside an XML document, so a header carrying a
 * space or a slash must never reach it.
 */
function safeHost(value: string | null): string | null {
  if (!value) return null;
  const host = value.split(",")[0]!.trim();
  if (!host || /[\s/\\]/.test(host)) return null;
  return host;
}

function header(headers: Headers, name: string): string | null {
  return safeHost(headers.get(name));
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTNAMES.has(host) || host === "::1") return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function build(
  protocol: string,
  host: string,
  source: PublicOrigin["source"],
): PublicOrigin | null {
  let url: URL;
  try {
    url = new URL(`${protocol}//${host}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    origin: url.origin,
    secure: url.protocol === "https:",
    loopback: isLoopback(url.hostname),
    source,
  };
}

/**
 * Resolves the origin that an external device would use to reach this server.
 *
 * iOS over-the-air installation requires publicly trusted HTTPS for both the
 * manifest and the package, so callers use `secure` to decide whether to offer
 * installation at all. `PUBLIC_BASE_URL` wins over the forwarded headers because
 * only the operator knows the true public address when a proxy rewrites them; an
 * unusable value falls through rather than throwing, so a typo degrades to a
 * disabled button instead of a server error.
 */
export function resolvePublicOrigin(
  headers: Headers,
  env: Partial<Record<string, string>> = process.env,
): PublicOrigin | null {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return {
          origin: url.origin,
          secure: url.protocol === "https:",
          loopback: isLoopback(url.hostname),
          source: "env",
        };
      }
    } catch {
      // Fall through to the request headers.
    }
  }

  const forwardedProtocol = header(headers, "x-forwarded-proto");
  const forwardedHost = header(headers, "x-forwarded-host");
  const host = header(headers, "host");

  if (forwardedProtocol && (forwardedHost ?? host)) {
    const resolved = build(
      `${forwardedProtocol}:`,
      (forwardedHost ?? host)!,
      "forwarded",
    );
    if (resolved) return resolved;
  }
  if (forwardedHost) {
    const resolved = build("http:", forwardedHost, "forwarded");
    if (resolved) return resolved;
  }
  if (host) return build("http:", host, "host");
  return null;
}
