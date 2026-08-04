/**
 * The single allowlist of origins this server may be reached at.
 *
 * One list answers a question that used to be spread across `BETTER_AUTH_URL`
 * (which doubled as the sole CSRF-trusted origin) and `ALLOWED_DEV_ORIGINS`
 * (the Next.js dev-server allowlist, with no production effect). `PUBLIC_BASE_URL`
 * stays separate because it answers a different question: which single origin to
 * write into a link handed to an external system.
 *
 * This module is imported by `next.config.ts`, which loads before TypeScript path
 * aliases resolve, so it must not import anything under `@/`.
 */

export type OriginPattern = {
  /** `app.example.com` or `*.example.com`; never carries a port. */
  hostname: string;
  /** `hostname` plus `:port` when the entry pinned one. */
  host: string;
  port: string | null;
  /** `null` when the entry was written without a scheme. */
  protocol: "http:" | "https:" | null;
  wildcard: boolean;
  loopback: boolean;
};

export type AppOrigins = {
  patterns: OriginPattern[];
  /**
   * The origin to use when no request is in hand — background jobs, webhook
   * registration, notification links. `PUBLIC_BASE_URL` when set, otherwise the
   * first exact (non-wildcard) origin.
   */
  canonical: string;
  /** `single` pins a static origin; `multi` resolves per request against the allowlist. */
  mode: "single" | "multi";
  /** Every non-loopback origin is https, so cookies can be pinned to `Secure`. */
  allHttps: boolean;
};

export type OriginEnvironment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTNAMES.has(host) || host === "::1") return true;
  if (host.endsWith(".localhost")) return true;
  return /^127\./.test(host);
}

/**
 * Wildcards may only replace the leftmost label, and at least two literal labels
 * must remain.
 *
 * That rejects `*`, `*.com`, and `https://*`, but it cannot tell a domain you own
 * from a public suffix — `*.ts.net` passes this check. Wildcards are rejected
 * outright in production for that reason; in development the operator is expected
 * to only wildcard a domain they control.
 */
function validateWildcard(hostname: string, entry: string): void {
  const labels = hostname.split(".");
  if (labels.slice(1).some((label) => label.includes("*"))) {
    throw new Error(
      `APP_ORIGINS entry "${entry}" may only use a wildcard in its leftmost label.`,
    );
  }
  if (labels[0] !== "*") {
    throw new Error(
      `APP_ORIGINS entry "${entry}" must use "*" as a whole label, for example "*.example.com".`,
    );
  }
  if (labels.length < 3) {
    throw new Error(
      `APP_ORIGINS entry "${entry}" is too broad; a wildcard needs at least two literal labels after it.`,
    );
  }
}

export function parseOriginPattern(entry: string): OriginPattern {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error("APP_ORIGINS contains an empty entry.");
  if (/[\s/\\]/.test(trimmed.replace(/^https?:\/\//, ""))) {
    throw new Error(
      `APP_ORIGINS entry "${trimmed}" must be a bare host or an origin, with no path.`,
    );
  }
  if (trimmed.includes("@")) {
    throw new Error(
      `APP_ORIGINS entry "${trimmed}" must not contain credentials.`,
    );
  }

  const schemeMatch = /^(https?):\/\/(.+)$/.exec(trimmed);
  const protocol = schemeMatch
    ? ((schemeMatch[1] === "https" ? "https:" : "http:") as "http:" | "https:")
    : null;
  const authority = schemeMatch ? schemeMatch[2]! : trimmed;

  // Parsed by hand rather than through `new URL`, because a wildcard host is not
  // a legal URL and because `URL` would silently accept a path we must reject.
  const portMatch = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!portMatch) {
    throw new Error(`APP_ORIGINS entry "${trimmed}" is not a valid host.`);
  }
  const hostname = portMatch[1]!.toLowerCase();
  const port = portMatch[2] ?? null;
  if (!hostname || hostname === ".") {
    throw new Error(`APP_ORIGINS entry "${trimmed}" is not a valid host.`);
  }

  const wildcard = hostname.includes("*");
  if (wildcard) validateWildcard(hostname, trimmed);

  return {
    hostname,
    host: port ? `${hostname}:${port}` : hostname,
    port,
    protocol,
    wildcard,
    loopback: isLoopback(hostname),
  };
}

function developmentDefaults(env: OriginEnvironment): OriginPattern[] {
  const port = env.PORT?.trim() || "3000";
  return ["localhost", "127.0.0.1", "[::1]"].map((host) =>
    parseOriginPattern(`http://${host}:${port}`),
  );
}

/**
 * Collapses entries naming the same host. Matching only ever considers the host,
 * so a duplicate adds nothing; when two spellings disagree on scheme the plaintext
 * one wins, because `allHttps` gates the `Secure` cookie flag and must never
 * over-claim.
 */
function dedupe(patterns: OriginPattern[]): OriginPattern[] {
  const seen = new Map<string, OriginPattern>();
  for (const pattern of patterns) {
    const existing = seen.get(pattern.host);
    if (!existing) {
      seen.set(pattern.host, pattern);
    } else if (pattern.protocol === "http:") {
      seen.set(pattern.host, { ...existing, protocol: "http:" });
    }
  }
  return [...seen.values()];
}

function originOf(pattern: OriginPattern): string {
  const protocol = pattern.protocol ?? (pattern.loopback ? "http:" : "https:");
  return `${protocol}//${pattern.host}`;
}

function parsePublicBaseURL(env: OriginEnvironment): URL | null {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use http or https.");
  }
  return url;
}

export function resolveAppOrigins(
  env: OriginEnvironment = process.env,
): AppOrigins {
  // A production *build* prerenders pages without production configuration, so it
  // gets the development defaults rather than failing. Nothing it renders is
  // origin-sensitive; the runtime check below is the one that matters.
  const isBuild = env.NEXT_PHASE === "phase-production-build";
  const isProduction = env.NODE_ENV === "production" && !isBuild;

  const configured = env.APP_ORIGINS?.trim();
  const publicBaseURL = parsePublicBaseURL(env);

  const listed = configured
    ? configured
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(parseOriginPattern)
    : [];

  if (isProduction && listed.length === 0 && !publicBaseURL) {
    throw new Error(
      "APP_ORIGINS is required in production. Set it to the origin this server is reached at, for example APP_ORIGINS=app.example.com",
    );
  }

  // Outside production the loopback origins are always trusted on top of anything
  // configured, so `npm run dev` keeps working no matter what APP_ORIGINS names —
  // the same union `next.config.ts` already applied to allowedDevOrigins.
  let patterns = isProduction
    ? listed
    : dedupe([...developmentDefaults(env), ...listed]);

  if (patterns.length === 0 && publicBaseURL) {
    patterns = [parseOriginPattern(publicBaseURL.origin)];
  }

  if (isProduction) {
    const wildcards = patterns.filter((pattern) => pattern.wildcard);
    if (wildcards.length > 0) {
      throw new Error(
        `APP_ORIGINS may not use wildcards in production (${wildcards
          .map((pattern) => pattern.hostname)
          .join(
            ", ",
          )}). A wildcard trusts every host under it for CSRF and for post-login redirects; list exact hosts instead.`,
      );
    }
  }

  // The canonical origin must itself be trusted, otherwise a link this server
  // hands out points at an origin its own CSRF check would reject.
  if (
    publicBaseURL &&
    !patterns.some((pattern) => matchesPattern(publicBaseURL.host, pattern))
  ) {
    patterns = [...patterns, parseOriginPattern(publicBaseURL.origin)];
  }

  // Wildcards describe a set, not an address, so they can never be canonical.
  const exact = patterns.find((pattern) => !pattern.wildcard);
  if (!exact && !publicBaseURL) {
    throw new Error(
      "APP_ORIGINS must include at least one exact origin; a wildcard alone gives this server no address to put in the links it generates.",
    );
  }
  const canonical = publicBaseURL?.origin ?? originOf(exact!);

  return {
    patterns,
    canonical,
    mode: patterns.length === 1 && !patterns[0]!.wildcard ? "single" : "multi",
    allHttps: patterns.every(
      (pattern) => pattern.loopback || pattern.protocol !== "http:",
    ),
  };
}

/**
 * Matches a `host` header value (`host` or `host:port`) against one pattern.
 *
 * A pattern without a port matches any port: an attacker able to bind another
 * port on a host you have already trusted has that host, so the hostname is the
 * boundary worth enforcing. A pattern that pins a port is honoured exactly.
 */
export function matchesPattern(
  candidateHost: string,
  pattern: OriginPattern,
): boolean {
  const normalized = candidateHost.trim().toLowerCase();
  if (!normalized) return false;
  const portMatch = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(normalized);
  if (!portMatch) return false;
  const hostname = portMatch[1]!;
  const port = portMatch[2] ?? null;

  if (pattern.port && pattern.port !== port) return false;

  if (!pattern.wildcard) return pattern.hostname === hostname;
  const suffix = pattern.hostname.slice(1); // ".example.com"
  return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

/** True when a host header, origin, or absolute URL is on the allowlist. */
export function isTrustedOrigin(
  origins: AppOrigins,
  candidate: string,
): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  let host = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).host;
    } catch {
      return false;
    }
  }
  return origins.patterns.some((pattern) => matchesPattern(host, pattern));
}

/**
 * Better Auth's `baseURL`. A single exact origin is pinned statically so no
 * host-header logic runs at all; anything broader resolves per request against
 * `allowedHosts`.
 *
 * `protocol: "https"` is safe alongside loopback entries — Better Auth adds an
 * `http://` trusted origin for loopback hosts regardless of this setting.
 */
export function betterAuthBaseURL(
  origins: AppOrigins,
):
  | string
  | { allowedHosts: string[]; protocol: "https" | "auto"; fallback: string } {
  if (origins.mode === "single") return origins.canonical;
  return {
    allowedHosts: origins.patterns.map((pattern) => pattern.host),
    protocol: origins.allHttps ? "https" : "auto",
    fallback: origins.canonical,
  };
}

/** Hostnames for Next's `allowedDevOrigins`, which ignores scheme and port. */
export function devServerOrigins(origins: AppOrigins): string[] {
  return [...new Set(origins.patterns.map((pattern) => pattern.hostname))];
}
