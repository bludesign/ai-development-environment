import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthRuntimeConfig: vi.fn(),
  signInWithOAuth2: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  getAuth: async () => ({
    api: { signInWithOAuth2: mocks.signInWithOAuth2 },
  }),
  getAuthRuntimeConfig: mocks.getAuthRuntimeConfig,
  oauthAuthenticationEnabled: () => true,
}));

import { GET } from "./route";

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
    mocks.signInWithOAuth2.mockResolvedValue(
      Response.json({ url: "https://identity.example.com/authorize" }),
    );
  });

  test("uses the trusted forwarded origin for the completion callback", async () => {
    const response = await GET(
      new Request("http://127.0.0.1:3000/api/auth/mobile/oauth/start", {
        headers: {
          host: "127.0.0.1:3000",
          "x-forwarded-host": "control.example.com",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(response.status).toBe(302);
    const invocation = mocks.signInWithOAuth2.mock.calls[0]?.[0] as {
      body: { callbackURL: string; errorCallbackURL: string };
    };
    const callback = new URL(invocation.body.callbackURL);
    expect(callback.origin).toBe("https://control.example.com");
    expect(callback.pathname).toBe("/api/auth/mobile/oauth/complete");
    expect(invocation.body.errorCallbackURL).toBe(invocation.body.callbackURL);
  });
});
