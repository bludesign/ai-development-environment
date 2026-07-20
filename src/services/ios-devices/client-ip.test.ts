// @vitest-environment node
import { describe, expect, test } from "vitest";

import { resolveClientIp } from "./client-ip";

describe("resolveClientIp", () => {
  test("prefers a valid Cloudflare address over forwarded headers", () => {
    expect(
      resolveClientIp(
        new Headers({
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.2, 10.0.0.1",
          "x-real-ip": "192.0.2.9",
        }),
      ),
    ).toEqual({ address: "203.0.113.7", source: "CLOUDFLARE" });
  });

  test("uses the first valid forwarded address when Cloudflare is absent", () => {
    expect(
      resolveClientIp(
        new Headers({
          "cf-connecting-ip": "not-an-ip",
          "x-forwarded-for": "unknown, [2001:db8::4]:443, 198.51.100.2",
          "x-real-ip": "192.0.2.9",
        }),
      ),
    ).toEqual({ address: "2001:db8::4", source: "FORWARDED" });
  });

  test("falls back to X-Real-IP and normalizes mapped IPv4", () => {
    expect(
      resolveClientIp(new Headers({ "x-real-ip": "::ffff:192.0.2.12" })),
    ).toEqual({ address: "192.0.2.12", source: "REAL_IP" });
  });

  test("returns null when no candidate is a valid IP address", () => {
    expect(
      resolveClientIp(
        new Headers({
          "cf-connecting-ip": "invalid",
          "x-forwarded-for": "unknown",
          "x-real-ip": "also-invalid",
        }),
      ),
    ).toBeNull();
  });
});
