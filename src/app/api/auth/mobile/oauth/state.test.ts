import { describe, expect, test } from "vitest";

import {
  clearedMobileOAuthStateCookie,
  createMobileOAuthState,
  MOBILE_OAUTH_STATE_COOKIE,
  mobileOAuthStateCookie,
  readMobileOAuthState,
  stateMatches,
} from "./state";

const httpsRequest = new Request(
  "https://control.example.com/api/auth/mobile/oauth/start",
);
const httpRequest = new Request(
  "http://control.example.com/api/auth/mobile/oauth/start",
);

describe("mobile OAuth state", () => {
  test("issues an unguessable value", () => {
    const values = new Set(
      Array.from({ length: 50 }, () => createMobileOAuthState()),
    );
    expect(values.size).toBe(50);
    for (const value of values) {
      // 32 bytes, base64url — no padding, nothing needing escaping in a cookie.
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  test("scopes the cookie to the mobile routes and hides it from script", () => {
    const cookie = mobileOAuthStateCookie("abc", httpsRequest, false);
    expect(cookie).toContain(`${MOBILE_OAUTH_STATE_COOKIE}=abc`);
    expect(cookie).toContain("Path=/api/auth/mobile");
    expect(cookie).toContain("HttpOnly");
    // Lax, not Strict: the return leg of the OAuth round trip is a top-level
    // navigation from the identity provider, and Strict would drop it.
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  test("omits Secure on a plaintext origin, where the browser would drop it", () => {
    expect(mobileOAuthStateCookie("abc", httpRequest, false)).not.toContain(
      "Secure",
    );
  });

  test("follows the forwarded scheme only when proxies are trusted", () => {
    const proxied = new Request(
      "http://internal:3000/api/auth/mobile/oauth/start",
      {
        headers: {
          "x-forwarded-host": "control.example.com",
          "x-forwarded-proto": "https",
        },
      },
    );
    expect(mobileOAuthStateCookie("abc", proxied, true)).toContain("Secure");
    expect(mobileOAuthStateCookie("abc", proxied, false)).not.toContain(
      "Secure",
    );
  });

  test("retires the state with an expiring cookie", () => {
    const cleared = clearedMobileOAuthStateCookie(httpsRequest, false);
    expect(cleared).toContain(`${MOBILE_OAUTH_STATE_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/api/auth/mobile");
  });

  test("reads its own cookie out of a crowded header", () => {
    const headers = new Headers({
      cookie: `other=1; ${MOBILE_OAUTH_STATE_COOKIE}=xyz; better-auth.session_token=abc`,
    });
    expect(readMobileOAuthState(headers)).toBe("xyz");
  });

  test.each([
    ["no cookie header", undefined],
    ["an unrelated cookie", "other=1"],
    ["an empty value", `${MOBILE_OAUTH_STATE_COOKIE}=`],
    [
      "a name that merely ends with the same text",
      `not-${MOBILE_OAUTH_STATE_COOKIE}=xyz`,
    ],
  ])("returns null for %s", (_label, cookie) => {
    const headers = new Headers(cookie ? { cookie } : {});
    expect(readMobileOAuthState(headers)).toBeNull();
  });

  test("matches only an exact pair", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "ab")).toBe(false);
  });

  test.each([
    ["a missing cookie", null, "abc"],
    ["a missing query value", "abc", null],
    ["both missing", null, null],
    ["two empty strings", "", ""],
  ])("refuses %s", (_label, expected, supplied) => {
    expect(stateMatches(expected, supplied)).toBe(false);
  });
});
