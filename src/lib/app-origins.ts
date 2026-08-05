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
   *
   * `null` in `inferred` mode: nothing was configured, so the server has no
   * address to name except the one on the request in front of it.
   */
  canonical: string | null;
  /**
   * `single` pins a static origin; `multi` resolves per request against the
   * allowlist; `inferred` means nothing was configured and each request's own
   * host is trusted.
   */
  mode: "single" | "multi" | "inferred";
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
 * one wins, because `allHttps` decides whether the base URL is pinned to https and
 * must never over-claim.
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

/**
 * The scheme an entry stands for when it was written without one.
 *
 * Loopback is plaintext because that is what `next dev` serves. Any other
 * scheme-less host follows the environment: https in production, where plaintext
 * is never the intended default, and http outside it, because the common
 * development spelling — a bare LAN address such as `192.168.1.50`, which
 * `.env.example` invites — is reached over http. Guessing https there would pin
 * the base URL to a scheme the dev server does not answer on and mark session
 * cookies `Secure`, which the browser then drops on a plaintext LAN origin,
 * breaking sign-in with no diagnostic.
 */
function effectiveProtocol(
  pattern: OriginPattern,
  isProduction: boolean,
): "http:" | "https:" {
  if (pattern.protocol) return pattern.protocol;
  if (pattern.loopback) return "http:";
  return isProduction ? "https:" : "http:";
}

function originOf(pattern: OriginPattern, isProduction: boolean): string {
  return `${effectiveProtocol(pattern, isProduction)}//${pattern.host}`;
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

// `resolveAppOrigins` runs per request, so the notice is emitted once per process
// rather than once per call.
let warnedAboutInferredOrigins = false;

function warnOnceAboutInferredOrigins(): void {
  if (warnedAboutInferredOrigins) return;
  warnedAboutInferredOrigins = true;
  console.warn(
    "[origins] Neither APP_ORIGINS nor PUBLIC_BASE_URL is set. Each request's own Host header will be trusted, " +
      "so absolute URLs this server generates — OAuth callbacks, iOS enrollment and install links, the GitHub " +
      "webhook URL — follow whatever host the caller asked for. Set APP_ORIGINS to the hostname(s) this server " +
      "is reached at to pin them.",
  );
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

  // Configuring nothing is allowed. The server then trusts whatever host each
  // request arrived on, which is what an unconfigured deployment did before this
  // allowlist existed. Browsers set `Host` to the real destination, so a
  // cross-origin CSRF attempt still fails — what is given up is the guarantee
  // that absolute URLs this server *generates* (OAuth redirect_uri, iOS
  // enrollment and OTA links, the GitHub webhook URL) name a host the operator
  // vouched for. Setting APP_ORIGINS or PUBLIC_BASE_URL restores that.
  if (isProduction && listed.length === 0 && !publicBaseURL) {
    warnOnceAboutInferredOrigins();
    return {
      patterns: [],
      canonical: null,
      mode: "inferred",
      allHttps: false,
    };
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
  const canonical = publicBaseURL?.origin ?? originOf(exact!, isProduction);

  return {
    patterns,
    canonical,
    mode: patterns.length === 1 && !patterns[0]!.wildcard ? "single" : "multi",
    // Loopback is exempt: browsers treat http://localhost as a secure context, so
    // a plaintext loopback entry alongside https hosts does not force the whole
    // deployment down to `auto`.
    allHttps: patterns.every(
      (pattern) =>
        pattern.loopback ||
        effectiveProtocol(pattern, isProduction) === "https:",
    ),
  };
}

/** Whether a value is a bare `host` or `host:port`, with nothing else in it. */
function isHostShaped(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /[\s/\\@]/.test(normalized)) return false;
  return /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.test(normalized);
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

/**
 * True when a host header, origin, or absolute URL is on the allowlist.
 *
 * In `inferred` mode there is no allowlist to check against, so every
 * syntactically valid candidate is accepted. Callers that need to know whether an
 * operator actually vouched for the host must test `mode` themselves.
 */
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
  // Inferred mode has no allowlist to check against, but a value that is not a
  // host at all is still rejected — it would be about to be interpolated into a
  // URL either way.
  if (origins.mode === "inferred") return isHostShaped(host);
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
  | undefined
  | { allowedHosts: string[]; protocol: "https" | "auto"; fallback: string } {
  // `undefined` hands the decision to Better Auth, which derives the base URL —
  // and therefore its trusted origin — from each request's own host. The CSRF
  // check still holds: a browser sets `Host` to the real destination, so a
  // cross-site POST arrives with a foreign `Origin` and is rejected.
  if (origins.mode === "inferred") return undefined;
  if (origins.mode === "single") return origins.canonical!;
  return {
    // Better Auth matches `allowedHosts` against the complete host, including
    // its port. APP_ORIGINS deliberately treats an entry without a port as
    // port-insensitive, so add a second Better Auth pattern for that case.
    // The `:*` suffix keeps a wildcard bounded to the host's port separator;
    // appending `*` to the hostname itself would also match unrelated names.
    allowedHosts: origins.patterns.flatMap((pattern) =>
      pattern.port ? [pattern.host] : [pattern.host, `${pattern.host}:*`],
    ),
    protocol: origins.allHttps ? "https" : "auto",
    fallback: origins.canonical!,
  };
}

/**
 * The origin a request arrived on, as this server can best determine it.
 *
 * Forwarded headers are consulted only when the operator has declared a proxy;
 * otherwise the `Host` header is used, falling back to the request URL. Used in
 * `inferred` mode, where the request itself is the only available statement of
 * what this server is called.
 */
export function originFromRequest(
  request: Request,
  trustProxyHeaders: boolean,
): string | null {
  const header = (name: string): string | null => {
    const value = request.headers.get(name)?.split(",")[0]?.trim();
    return value && !/[\s/\\@]/.test(value) ? value : null;
  };

  const forwardedHost = trustProxyHeaders ? header("x-forwarded-host") : null;
  const forwardedProtocol = trustProxyHeaders
    ? header("x-forwarded-proto")
    : null;
  const host = forwardedHost ?? header("host");

  if (host && isHostShaped(host)) {
    const protocol =
      forwardedProtocol === "https" || forwardedProtocol === "http"
        ? forwardedProtocol
        : new URL(request.url).protocol.replace(":", "");
    return `${protocol}://${host.toLowerCase()}`;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a request was issued by the site itself rather than by another origin.
 *
 * Used to guard endpoints authenticated by the session cookie. `SameSite=Lax`
 * already withholds that cookie from cross-site POSTs, but it still sends it on
 * top-level cross-site navigations, and it is a browser default rather than
 * something this server states — a future `sameSite: "none"` (for a native client,
 * or a cross-subdomain deployment) would silently remove the only protection these
 * routes have. This states it.
 *
 * `Sec-Fetch-Site` is preferred where the browser sends it, because it describes
 * the whole redirect chain rather than just the final hop. `none` is a
 * user-initiated load — typed, bookmarked, or a download the user clicked — and is
 * as trustworthy as `same-origin`. A request with neither header is not from a
 * browser (curl, an MCP client, the control agent), so there is no ambient
 * credential to abuse and nothing to check.
 */
export function isSameOriginRequest(
  request: Request,
  trustProxyHeaders: boolean,
): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";

  const origin = request.headers.get("origin");
  if (!origin) return true;
  const self = originFromRequest(request, trustProxyHeaders);
  return Boolean(self) && origin.trim().toLowerCase() === self;
}

/**
 * Whether a browser at `origin` may open a WebSocket to this server.
 *
 * WebSocket handshakes are not subject to CORS, so an `Origin` check is the only
 * thing standing between a hostile page and a connection carrying the visitor's
 * cookies. `SameSite=Lax` withholds those today, but the agent socket listens on
 * its own port with nothing else in front of it, so the rule is stated here.
 *
 * A handshake with no `Origin` is not from a browser — the control agent and the
 * CLI both connect this way — and carries no ambient credential, so it passes.
 *
 * Matching is port-insensitive by construction: the dashboard runs on the HTTP
 * port and connects to the socket on another, so the page's origin never equals
 * the socket's. An allowlist entry without a port already matches any port; in
 * `inferred` mode, where there is no allowlist, the hostname of the handshake's
 * own `Host` is the only reference point available.
 */
export function isTrustedWebSocketOrigin(
  origins: AppOrigins,
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;

  let originHostname: string;
  try {
    originHostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!originHostname) return false;

  if (origins.mode !== "inferred") {
    return origins.patterns.some((pattern) =>
      matchesPattern(originHostname, pattern),
    );
  }

  if (!host || !isHostShaped(host)) return false;
  const hostname = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/
    .exec(host.trim().toLowerCase())?.[1]
    ?.toLowerCase();
  return Boolean(hostname) && hostname === originHostname;
}

/** Hostnames for Next's `allowedDevOrigins`, which ignores scheme and port. */
export function devServerOrigins(origins: AppOrigins): string[] {
  return [...new Set(origins.patterns.map((pattern) => pattern.hostname))];
}
