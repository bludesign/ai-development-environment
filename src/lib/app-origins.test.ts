import { describe, expect, test } from "vitest";

import {
  betterAuthBaseURL,
  devServerOrigins,
  isSameOriginRequest,
  isTrustedOrigin,
  isTrustedWebSocketOrigin,
  parseOriginPattern,
  resolveAppOrigins,
} from "./app-origins";

describe("parseOriginPattern", () => {
  test("accepts bare hosts, ports, and explicit schemes", () => {
    expect(parseOriginPattern("app.example.com")).toMatchObject({
      hostname: "app.example.com",
      protocol: null,
      wildcard: false,
    });
    expect(parseOriginPattern("https://app.example.com")).toMatchObject({
      protocol: "https:",
      host: "app.example.com",
    });
    expect(parseOriginPattern("10.0.0.5:3000")).toMatchObject({
      hostname: "10.0.0.5",
      port: "3000",
      host: "10.0.0.5:3000",
    });
  });

  test("marks loopback hosts", () => {
    expect(parseOriginPattern("localhost:3000").loopback).toBe(true);
    expect(parseOriginPattern("127.0.0.1").loopback).toBe(true);
    expect(parseOriginPattern("app.example.com").loopback).toBe(false);
  });

  test.each([
    ["*", "a bare wildcard"],
    ["*.com", "a wildcard over a single label"],
    ["https://*", "a scheme-only wildcard"],
    ["ex*.example.com", "a partial-label wildcard"],
    ["*.*.example.com", "a wildcard outside the leftmost label"],
  ])("rejects %s (%s)", (entry) => {
    expect(() => parseOriginPattern(entry)).toThrow();
  });

  test.each([
    "https://app.example.com/path",
    "app.example.com/",
    "user:pass@app.example.com",
    "app example.com",
  ])("rejects %s", (entry) => {
    expect(() => parseOriginPattern(entry)).toThrow();
  });

  test("allows a wildcard with two literal labels remaining", () => {
    expect(parseOriginPattern("*.example.com").wildcard).toBe(true);
  });
});

describe("resolveAppOrigins", () => {
  test("defaults to loopback in development", () => {
    const origins = resolveAppOrigins({ NODE_ENV: "development" });
    expect(devServerOrigins(origins)).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]);
    expect(origins.mode).toBe("multi");
  });

  test("honours PORT in the development defaults", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "development",
      PORT: "3090",
    });
    expect(origins.patterns.every((p) => p.port === "3090")).toBe(true);
  });

  test("pins a single configured origin statically", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "app.example.com",
    });
    expect(origins.mode).toBe("single");
    expect(betterAuthBaseURL(origins)).toBe("https://app.example.com");
  });

  test("assumes http only for loopback when no scheme is given", () => {
    expect(resolveAppOrigins({ APP_ORIGINS: "localhost:3000" }).canonical).toBe(
      "http://localhost:3000",
    );
    expect(
      resolveAppOrigins({
        NODE_ENV: "production",
        APP_ORIGINS: "app.example.com",
      }).canonical,
    ).toBe("https://app.example.com");
  });

  test("always trusts loopback outside production, on top of APP_ORIGINS", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "development",
      APP_ORIGINS: "*.hare-bull.ts.net",
    });
    expect(isTrustedOrigin(origins, "localhost:3000")).toBe(true);
    expect(isTrustedOrigin(origins, "box.hare-bull.ts.net")).toBe(true);
    expect(origins.canonical).toBe("http://localhost:3000");
  });

  test("does not add loopback defaults in production", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "app.example.com",
    });
    expect(isTrustedOrigin(origins, "localhost:3000")).toBe(false);
  });

  test("resolves multiple origins dynamically", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "app.example.com,admin.example.com",
    });
    expect(origins.mode).toBe("multi");
    expect(betterAuthBaseURL(origins)).toMatchObject({
      allowedHosts: [
        "app.example.com",
        "app.example.com:*",
        "admin.example.com",
        "admin.example.com:*",
      ],
      protocol: "https",
    });
  });

  test("keeps an unpinned wildcard host port-insensitive for Better Auth", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "development",
      APP_ORIGINS: "*.hare-bull.ts.net",
    });
    expect(betterAuthBaseURL(origins)).toMatchObject({
      allowedHosts: expect.arrayContaining([
        "*.hare-bull.ts.net",
        "*.hare-bull.ts.net:*",
      ]),
    });
  });

  test("drops to auto protocol when a plaintext non-loopback origin is listed", () => {
    const origins = resolveAppOrigins({
      APP_ORIGINS: "http://app.example.com,https://admin.example.com",
    });
    expect(origins.allHttps).toBe(false);
    expect(betterAuthBaseURL(origins)).toMatchObject({ protocol: "auto" });
  });

  test("loopback entries do not disqualify an https deployment", () => {
    const origins = resolveAppOrigins({
      APP_ORIGINS: "https://app.example.com,http://localhost:3000",
    });
    expect(origins.allHttps).toBe(true);
  });

  test("a scheme-less LAN address is plaintext outside production", () => {
    // `.env.example` invites a bare host, and `next dev` answers such an address
    // over http. Reading it as https would pin the base URL to a scheme the dev
    // server never speaks and mark cookies Secure, which the browser then drops.
    const development = resolveAppOrigins({ APP_ORIGINS: "192.168.1.50:3000" });
    expect(development.allHttps).toBe(false);
    expect(betterAuthBaseURL(development)).toMatchObject({ protocol: "auto" });

    // In production the same spelling means https: plaintext is never the
    // intended default for a deployment.
    const production = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "app.example.com",
    });
    expect(production.allHttps).toBe(true);
  });

  test("falls back to trusting each request's host when nothing is configured", () => {
    const origins = resolveAppOrigins({ NODE_ENV: "production" });
    expect(origins.mode).toBe("inferred");
    expect(origins.canonical).toBeNull();
    expect(origins.patterns).toEqual([]);
    // Better Auth derives its own base URL, and therefore its trusted origin,
    // from the request.
    expect(betterAuthBaseURL(origins)).toBeUndefined();
  });

  test("inferred mode accepts any syntactically valid host", () => {
    const origins = resolveAppOrigins({ NODE_ENV: "production" });
    expect(isTrustedOrigin(origins, "anything.example.com")).toBe(true);
    expect(isTrustedOrigin(origins, "https://anything.example.com")).toBe(true);
    expect(isTrustedOrigin(origins, "")).toBe(false);
    expect(isTrustedOrigin(origins, "not a host")).toBe(false);
  });

  test("configuring either variable leaves inferred mode", () => {
    expect(
      resolveAppOrigins({ NODE_ENV: "production", APP_ORIGINS: "app.test" })
        .mode,
    ).not.toBe("inferred");
    expect(
      resolveAppOrigins({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://builds.test",
      }).mode,
    ).not.toBe("inferred");
    // Once anything is configured, an unlisted host is rejected again.
    const pinned = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "app.test",
    });
    expect(isTrustedOrigin(pinned, "attacker.test")).toBe(false);
  });

  test("development never infers", () => {
    expect(resolveAppOrigins({ NODE_ENV: "development" }).mode).not.toBe(
      "inferred",
    );
    expect(
      isTrustedOrigin(
        resolveAppOrigins({ NODE_ENV: "development" }),
        "attacker.test",
      ),
    ).toBe(false);
  });

  test("allows a production build to prerender without configuration", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
    });
    expect(origins.patterns.length).toBeGreaterThan(0);
  });

  test("rejects wildcards in production", () => {
    expect(() =>
      resolveAppOrigins({
        NODE_ENV: "production",
        APP_ORIGINS: "*.example.com",
      }),
    ).toThrow(/may not use wildcards in production/);
  });

  test("permits wildcards outside production", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "development",
      APP_ORIGINS: "*.hare-bull.ts.net",
    });
    expect(origins.mode).toBe("multi");
  });

  test("PUBLIC_BASE_URL becomes the canonical origin and is trusted", () => {
    const origins = resolveAppOrigins({
      APP_ORIGINS: "app.example.com",
      PUBLIC_BASE_URL: "https://builds.example.com",
    });
    expect(origins.canonical).toBe("https://builds.example.com");
    expect(isTrustedOrigin(origins, "https://builds.example.com")).toBe(true);
    expect(isTrustedOrigin(origins, "https://app.example.com")).toBe(true);
  });

  test("PUBLIC_BASE_URL alone is enough in production", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://builds.example.com",
    });
    expect(origins.mode).toBe("single");
    expect(origins.canonical).toBe("https://builds.example.com");
  });

  test("does not duplicate PUBLIC_BASE_URL when it is already listed", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "builds.example.com",
      PUBLIC_BASE_URL: "https://builds.example.com",
    });
    expect(origins.patterns).toHaveLength(1);
  });

  test("PUBLIC_BASE_URL outranks APP_ORIGINS as the canonical origin", () => {
    const origins = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "app.example.com,admin.example.com",
      PUBLIC_BASE_URL: "https://builds.example.com",
    });
    expect(origins.canonical).toBe("https://builds.example.com");
    expect(origins.patterns).toHaveLength(3);
  });

  test("rejects an unusable PUBLIC_BASE_URL rather than ignoring it", () => {
    expect(() => resolveAppOrigins({ PUBLIC_BASE_URL: "not a url" })).toThrow(
      /PUBLIC_BASE_URL/,
    );
    expect(() =>
      resolveAppOrigins({ PUBLIC_BASE_URL: "ftp://builds.example.com" }),
    ).toThrow(/http or https/);
  });
});

describe("isTrustedOrigin", () => {
  const origins = resolveAppOrigins({
    APP_ORIGINS: "app.example.com,*.hare-bull.ts.net,10.0.0.5:3000",
  });

  test.each([
    "app.example.com",
    "https://app.example.com",
    "box.hare-bull.ts.net",
    "https://box.hare-bull.ts.net",
    "10.0.0.5:3000",
  ])("trusts %s", (candidate) => {
    expect(isTrustedOrigin(origins, candidate)).toBe(true);
  });

  test.each([
    "evil.example.com",
    "hare-bull.ts.net",
    "app.example.com.evil.test",
    "https://evil.test",
    "",
  ])("rejects %s", (candidate) => {
    expect(isTrustedOrigin(origins, candidate)).toBe(false);
  });

  test("honours a pinned port but ignores an unpinned one", () => {
    expect(isTrustedOrigin(origins, "10.0.0.5:9999")).toBe(false);
    expect(isTrustedOrigin(origins, "app.example.com:8443")).toBe(true);
  });
});

describe("isSameOriginRequest", () => {
  const url = "https://control.example.com/api/tools/call";

  function request(headers: Record<string, string>): Request {
    return new Request(url, { method: "POST", headers });
  }

  test.each([
    ["a same-origin fetch", { "sec-fetch-site": "same-origin" }],
    ["a user-initiated load", { "sec-fetch-site": "none" }],
    ["a matching Origin", { origin: "https://control.example.com" }],
    ["a client that sends neither header", {}],
  ])("accepts %s", (_label, headers) => {
    expect(isSameOriginRequest(request(headers), false)).toBe(true);
  });

  test.each([
    ["a cross-site request", { "sec-fetch-site": "cross-site" }],
    ["a sibling subdomain", { "sec-fetch-site": "same-site" }],
    ["a foreign Origin", { origin: "https://evil.test" }],
    ["an opaque Origin", { origin: "null" }],
    [
      "a foreign Origin even when the scheme matches",
      { origin: "https://control.example.com.evil.test" },
    ],
  ])("refuses %s", (_label, headers) => {
    expect(isSameOriginRequest(request(headers), false)).toBe(false);
  });

  test("Sec-Fetch-Site outranks a forged Origin", () => {
    // The header the browser sets describes the whole redirect chain, so it wins
    // over an Origin that happens to look right.
    expect(
      isSameOriginRequest(
        request({
          "sec-fetch-site": "cross-site",
          origin: "https://control.example.com",
        }),
        false,
      ),
    ).toBe(false);
  });

  test("follows the forwarded host only when proxies are trusted", () => {
    const forwarded = new Request("http://internal:3000/api/tools/call", {
      method: "POST",
      headers: {
        origin: "https://control.example.com",
        "x-forwarded-host": "control.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(forwarded, true)).toBe(true);
    expect(isSameOriginRequest(forwarded, false)).toBe(false);
  });
});

describe("isTrustedWebSocketOrigin", () => {
  const configured = resolveAppOrigins({
    NODE_ENV: "production",
    APP_ORIGINS: "app.example.com",
  });
  const inferred = resolveAppOrigins({ NODE_ENV: "production" });

  test("accepts a handshake with no Origin", () => {
    // The control agent and CLI connect this way, and carry no ambient credential.
    expect(
      isTrustedWebSocketOrigin(configured, undefined, "app.example.com"),
    ).toBe(true);
  });

  test("ignores the port, because the socket is on its own", () => {
    expect(
      isTrustedWebSocketOrigin(
        configured,
        "https://app.example.com",
        "app.example.com:3091",
      ),
    ).toBe(true);
  });

  test.each([
    ["http://localhost:3000", "localhost:3091"],
    ["http://127.0.0.1:3000", "127.0.0.1:3091"],
    ["http://[::1]:3000", "[::1]:3091"],
  ])(
    "accepts the development origin %s when its allowlist entry pins a port",
    (origin, host) => {
      const development = resolveAppOrigins({
        NODE_ENV: "development",
        PORT: "3000",
      });
      expect(isTrustedWebSocketOrigin(development, origin, host)).toBe(true);
    },
  );

  test("enforces a configured origin port for WebSocket matching", () => {
    const portPinned = resolveAppOrigins({
      NODE_ENV: "production",
      APP_ORIGINS: "https://app.example.com:8443",
    });
    expect(
      isTrustedWebSocketOrigin(
        portPinned,
        "https://app.example.com:8443",
        "app.example.com:3091",
      ),
    ).toBe(true);
    expect(
      isTrustedWebSocketOrigin(
        portPinned,
        "https://app.example.com:3000",
        "app.example.com:3091",
      ),
    ).toBe(false);
  });

  test.each([
    "https://evil.test",
    "https://app.example.com.evil.test",
    "not a url",
    "null",
  ])("rejects %s against a configured allowlist", (origin) => {
    expect(
      isTrustedWebSocketOrigin(configured, origin, "app.example.com:3091"),
    ).toBe(false);
  });

  test("falls back to the handshake's own host when nothing is configured", () => {
    expect(inferred.mode).toBe("inferred");
    expect(
      isTrustedWebSocketOrigin(
        inferred,
        "https://box.tailnet.ts.net",
        "box.tailnet.ts.net:3091",
      ),
    ).toBe(true);
    expect(
      isTrustedWebSocketOrigin(
        inferred,
        "https://evil.test",
        "box.tailnet.ts.net:3091",
      ),
    ).toBe(false);
  });

  test("rejects a browser origin when the host header is unusable", () => {
    expect(
      isTrustedWebSocketOrigin(inferred, "https://evil.test", undefined),
    ).toBe(false);
  });
});
