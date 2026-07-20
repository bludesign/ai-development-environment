import { describe, expect, test } from "vitest";

import { resolvePublicOrigin } from "./public-origin";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("resolvePublicOrigin", () => {
  test("prefers PUBLIC_BASE_URL over the request headers", () => {
    const resolved = resolvePublicOrigin(
      headers({
        "x-forwarded-proto": "https",
        "x-forwarded-host": "proxy.test",
      }),
      { PUBLIC_BASE_URL: "https://builds.example.com" },
    );
    expect(resolved).toMatchObject({
      origin: "https://builds.example.com",
      secure: true,
      source: "env",
    });
  });

  test("strips a path from PUBLIC_BASE_URL", () => {
    const resolved = resolvePublicOrigin(headers({}), {
      PUBLIC_BASE_URL: "https://builds.example.com/nested/path?a=b",
    });
    expect(resolved?.origin).toBe("https://builds.example.com");
  });

  test("falls through to headers when PUBLIC_BASE_URL is unparseable", () => {
    const resolved = resolvePublicOrigin(
      headers({ "x-forwarded-proto": "https", host: "tunnel.example.com" }),
      { PUBLIC_BASE_URL: "not a url" },
    );
    expect(resolved).toMatchObject({
      origin: "https://tunnel.example.com",
      source: "forwarded",
    });
  });

  test("falls through when PUBLIC_BASE_URL uses an unsupported scheme", () => {
    const resolved = resolvePublicOrigin(headers({ host: "local.test" }), {
      PUBLIC_BASE_URL: "ftp://builds.example.com",
    });
    expect(resolved).toMatchObject({ origin: "http://local.test" });
  });

  test("uses the first entry of comma separated forwarded headers", () => {
    const resolved = resolvePublicOrigin(
      headers({
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "outer.example.com, inner.internal",
      }),
      {},
    );
    expect(resolved?.origin).toBe("https://outer.example.com");
  });

  test("prefers the forwarded host over the host header", () => {
    const resolved = resolvePublicOrigin(
      headers({
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example.com",
        host: "127.0.0.1:3000",
      }),
      {},
    );
    expect(resolved?.origin).toBe("https://public.example.com");
  });

  test("reports insecure when only a host header is present", () => {
    const resolved = resolvePublicOrigin(
      headers({ host: "127.0.0.1:3000" }),
      {},
    );
    expect(resolved).toMatchObject({
      origin: "http://127.0.0.1:3000",
      secure: false,
      loopback: true,
      source: "host",
    });
  });

  test("returns null when no host can be determined", () => {
    expect(resolvePublicOrigin(headers({}), {})).toBeNull();
  });

  test("rejects hosts containing whitespace or path separators", () => {
    expect(
      resolvePublicOrigin(headers({ host: "evil.test/path" }), {}),
    ).toBeNull();
    expect(
      resolvePublicOrigin(headers({ host: "evil.test\\path" }), {}),
    ).toBeNull();
  });

  test.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["192.168.1.10", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["mac-studio.local", true],
    ["builds.example.com", false],
  ])("classifies %s loopback as %s", (host, loopback) => {
    const resolved = resolvePublicOrigin(headers({ host }), {});
    expect(resolved?.loopback).toBe(loopback);
  });

  test("treats a secure public origin as installable", () => {
    const resolved = resolvePublicOrigin(
      headers({ "x-forwarded-proto": "https", host: "builds.example.com" }),
      {},
    );
    expect(resolved).toMatchObject({ secure: true, loopback: false });
  });
});
