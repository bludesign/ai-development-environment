import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getRegistrationStatus: vi.fn(),
  getAuthRuntimeConfig: vi.fn(),
}));
vi.mock("@/services/auth", () => ({
  getAuth: async () => ({ api: { getSession: mocks.getSession } }),
  getRegistrationStatus: mocks.getRegistrationStatus,
  getAuthRuntimeConfig: mocks.getAuthRuntimeConfig,
}));

import { MOBILE_NEARBY_STATE_COOKIE } from "../nearby-state";
import { GET } from "./route";

function request(
  overrides: Record<string, string | null | undefined> = {},
): Request {
  const url = new URL("http://internal:3000/api/auth/mobile/start");
  for (const [name, value] of Object.entries({
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    ...overrides,
  })) {
    if (value != null) url.searchParams.set(name, value);
  }
  return new Request(url, {
    headers: {
      host: "internal:3000",
      "x-forwarded-host": "control.example.com",
      "x-forwarded-proto": "https",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(null);
  mocks.getRegistrationStatus.mockResolvedValue({
    enabled: false,
    setupRequired: false,
  });
  mocks.getAuthRuntimeConfig.mockReturnValue({
    mode: "password",
    provider: null,
    trustProxyHeaders: true,
    origins: {
      mode: "inferred",
      patterns: [],
      canonical: null,
      allHttps: false,
    },
  });
});

describe("nearby mobile sign-in start", () => {
  test.each(["password", "oidc", "both"])(
    "opens web sign-in for %s authentication",
    async (mode) => {
      mocks.getAuthRuntimeConfig.mockReturnValue({
        ...mocks.getAuthRuntimeConfig(),
        mode,
      });
      const response = await GET(request());
      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const destination = new URL(response.headers.get("location")!);
      expect(destination.origin).toBe("https://control.example.com");
      expect(destination.pathname).toBe("/sign-in");
      const completion = new URL(
        destination.searchParams.get("returnTo")!,
        destination,
      );
      expect(completion.pathname).toBe("/api/auth/mobile/complete");
      expect(completion.searchParams.get("state")).toBe("s".repeat(43));
      expect(completion.searchParams.get("code_challenge")).toBe(
        "c".repeat(43),
      );
      expect(completion.searchParams.get("callback")).toBe(
        "aide-auth://callback",
      );
      const state = completion.searchParams.get("browser_state");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.headers.get("set-cookie")).toContain(
        `${MOBILE_NEARBY_STATE_COOKIE}=${state};`,
      );
      expect(response.headers.get("set-cookie")).toContain("Secure");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    },
  );

  test("completes an existing browser session without entering the auth layout", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    const response = await GET(request());
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/api/auth/mobile/complete",
    );
    expect(mocks.getRegistrationStatus).not.toHaveBeenCalled();
  });

  test("opens registration when the first account is required", async () => {
    mocks.getRegistrationStatus.mockResolvedValue({
      enabled: true,
      setupRequired: true,
    });
    const response = await GET(request());
    const destination = new URL(response.headers.get("location")!);
    expect(destination.pathname).toBe("/register");
    expect(destination.searchParams.get("returnTo")).toContain(
      "/api/auth/mobile/complete?",
    );
  });

  test.each([
    { state: null },
    { state: "short" },
    { code_challenge: null },
    { code_challenge: "short" },
    { code_challenge_method: "plain" },
    { callback: "https://attacker.example/callback" },
  ])(
    "rejects malformed request %j before resolving a session",
    async (overrides) => {
      expect((await GET(request(overrides))).status).toBe(400);
      expect(mocks.getSession).not.toHaveBeenCalled();
    },
  );

  test("refuses an untrusted origin instead of moving a state cookie between hosts", async () => {
    mocks.getAuthRuntimeConfig.mockReturnValue({
      ...mocks.getAuthRuntimeConfig(),
      origins: {
        mode: "single",
        patterns: [
          {
            hostname: "trusted.example",
            host: "trusted.example",
            port: null,
            wildcard: false,
          },
        ],
      },
    });
    const response = await GET(request());
    expect(response.status).toBe(400);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  test("ignores unbound client purpose flags", async () => {
    const response = await GET(
      request({ sessionPurpose: "existing", platform: "ios" }),
    );
    const destination = new URL(response.headers.get("location")!);
    expect(destination.searchParams.get("returnTo")).not.toContain(
      "sessionPurpose",
    );
    expect(destination.searchParams.get("returnTo")).not.toContain("platform");
  });
});
