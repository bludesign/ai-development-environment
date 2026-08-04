import { describe, expect, test } from "vitest";

import {
  betterAuthBaseURL,
  devServerOrigins,
  isTrustedOrigin,
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
      allowedHosts: ["app.example.com", "admin.example.com"],
      protocol: "https",
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

  test("requires APP_ORIGINS in production", () => {
    expect(() => resolveAppOrigins({ NODE_ENV: "production" })).toThrow(
      /APP_ORIGINS is required in production/,
    );
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
