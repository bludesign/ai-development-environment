import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  generateOneTimeToken: vi.fn(),
  createTelevisionAuthorizationCode: vi.fn(),
}));
vi.mock("@/services/auth", () => ({
  getAuth: async () => ({
    api: {
      getSession: mocks.getSession,
      generateOneTimeToken: mocks.generateOneTimeToken,
    },
  }),
  getAuthRuntimeConfig: () => ({ trustProxyHeaders: false }),
}));
vi.mock("../pkce", async (original) => ({
  ...(await original<typeof import("../pkce")>()),
  createTelevisionAuthorizationCode: mocks.createTelevisionAuthorizationCode,
}));

import { MOBILE_NEARBY_STATE_COOKIE } from "../nearby-state";
import { MOBILE_OAUTH_STATE_COOKIE } from "../oauth/state";
import { GET } from "./route";

function request(
  overrides: Record<string, string | null | undefined> = {},
  cookie = `${MOBILE_NEARBY_STATE_COOKIE}=${"b".repeat(43)}`,
): Request {
  const url = new URL("https://control.example/api/auth/mobile/complete");
  for (const [name, value] of Object.entries({
    callback: "aide-auth://callback",
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    browser_state: "b".repeat(43),
    ...overrides,
  }))
    if (value != null) url.searchParams.set(name, value);
  return new Request(url, {
    headers: { cookie: `${cookie}; better-auth.session_token=browser-session` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.generateOneTimeToken.mockResolvedValue({ token: "one-time-token" });
  mocks.createTelevisionAuthorizationCode.mockResolvedValue("a".repeat(43));
});

describe("nearby mobile completion", () => {
  test("issues only a PKCE code with a server-bound television purpose", async () => {
    const response = await GET(request({ sessionPurpose: "existing" }));
    const callback = new URL(response.headers.get("location")!);
    expect(callback.searchParams.get("code")).toBe("a".repeat(43));
    expect(callback.searchParams.get("state")).toBe("s".repeat(43));
    expect(callback.searchParams.has("token")).toBe(false);
    expect(callback.searchParams.has("sessionPurpose")).toBe(false);
    expect(mocks.createTelevisionAuthorizationCode).toHaveBeenCalledWith(
      "one-time-token",
      "c".repeat(43),
    );
    expect(response.headers.get("set-cookie")).toContain(
      `${MOBILE_NEARBY_STATE_COOKIE}=;`,
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test.each([
    ["missing cookie", {}, ""],
    [
      "legacy OAuth cookie",
      {},
      `${MOBILE_OAUTH_STATE_COOKIE}=${"b".repeat(43)}`,
    ],
    ["mismatched state", { browser_state: "z".repeat(43) }, undefined],
    ["missing state", { browser_state: null }, undefined],
  ])(
    "rejects %s before resolving a browser session",
    async (_label, overrides, cookie) => {
      const response = await GET(request(overrides, cookie));
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("invalid_state");
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
    },
  );

  test.each([{ state: "short" }, { code_challenge: "short" }])(
    "rejects invalid PKCE parameters %j",
    async (overrides) => {
      const response = await GET(request(overrides));
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("invalid_request");
      expect(mocks.getSession).not.toHaveBeenCalled();
    },
  );

  test("rejects unregistered callbacks", async () => {
    expect(
      (await GET(request({ callback: "https://evil.example" }))).status,
    ).toBe(400);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  test("refuses a revoked browser session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await GET(request());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("authentication_failed");
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
  });

  test("sanitizes provider errors", async () => {
    const response = await GET(request({ error: "provider-secret" }));
    expect(response.headers.get("location")).not.toContain("provider-secret");
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  test("sanitizes code storage failures", async () => {
    mocks.createTelevisionAuthorizationCode.mockRejectedValue(
      new Error("database-secret"),
    );
    const response = await GET(request());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("server_error");
    expect(response.headers.get("location")).not.toContain("database-secret");
  });
});
