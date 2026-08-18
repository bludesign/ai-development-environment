import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthRuntimeConfig: vi.fn(),
  signInSocial: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  getAuth: async () => ({
    api: { signInSocial: mocks.signInSocial },
  }),
  getAuthRuntimeConfig: mocks.getAuthRuntimeConfig,
  oauthAuthenticationEnabled: () => true,
}));

import { GET } from "./route";

const CLIENT_STATE = "s".repeat(43);
const CODE_CHALLENGE = "c".repeat(43);

function startRequest(overrides: Record<string, string | null> = {}): Request {
  const url = new URL("http://127.0.0.1:3000/api/auth/mobile/oauth/start");
  const parameters: Record<string, string> = {
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: CLIENT_STATE,
  };
  for (const [name, value] of Object.entries({
    ...parameters,
    ...overrides,
  })) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return new Request(url, {
    headers: {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "control.example.com",
      "x-forwarded-proto": "https",
    },
  });
}

describe("mobile OAuth start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthRuntimeConfig.mockReturnValue({
      baseURL: null,
      mode: "oidc",
      origins: {
        allHttps: false,
        canonical: null,
        mode: "inferred",
        patterns: [],
      },
      provider: { providerId: "company-oidc" },
      trustProxyHeaders: true,
    });
    const response = Response.json({
      url: "https://identity.example.com/authorize",
    });
    response.headers.append(
      "set-cookie",
      "better-auth.oauth_state=encrypted; Path=/; HttpOnly",
    );
    mocks.signInSocial.mockResolvedValue(response);
  });

  test("uses the trusted forwarded origin for the completion callback", async () => {
    const response = await GET(startRequest());

    expect(response.status).toBe(302);
    const invocation = mocks.signInSocial.mock.calls[0]?.[0] as {
      body: {
        callbackURL: string;
        errorCallbackURL: string;
        provider: string;
      };
    };
    const callback = new URL(invocation.body.callbackURL);
    expect(callback.origin).toBe("https://control.example.com");
    expect(callback.pathname).toBe("/api/auth/mobile/oauth/complete");
    expect(callback.searchParams.get("state")).toBe(CLIENT_STATE);
    expect(callback.searchParams.get("code_challenge")).toBe(CODE_CHALLENGE);
    expect(callback.searchParams.get("browser_state")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(invocation.body.errorCallbackURL).toBe(invocation.body.callbackURL);
    expect(invocation.body.provider).toBe("company-oidc");
    expect(response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("better-auth.oauth_state=encrypted"),
        expect.stringContaining("aide-mobile-oauth-state="),
      ]),
    );
  });

  test.each([
    ["state", { state: null }],
    ["a valid state", { state: "short" }],
    ["code challenge", { code_challenge: null }],
    ["a valid code challenge", { code_challenge: "short" }],
    ["S256", { code_challenge_method: "plain" }],
  ])("requires %s", async (_label, overrides) => {
    const response = await GET(startRequest(overrides));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_PKCE_REQUEST" },
    });
    expect(mocks.signInSocial).not.toHaveBeenCalled();
  });

  test("rejects any callback other than the registered custom scheme", async () => {
    const response = await GET(
      startRequest({ callback: "https://attacker.example/callback" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_CALLBACK" },
    });
    expect(mocks.signInSocial).not.toHaveBeenCalled();
  });
});
