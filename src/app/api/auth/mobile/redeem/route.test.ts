import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeMobileAuthorizationCode: vi.fn(),
  verifyOneTimeToken: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  getAuth: async () => ({
    api: { verifyOneTimeToken: mocks.verifyOneTimeToken },
  }),
}));

vi.mock("../pkce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pkce")>()),
  consumeMobileAuthorizationCode: mocks.consumeMobileAuthorizationCode,
}));

import { POST } from "./route";

const CODE = "a".repeat(43);
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function request(body: unknown): Request {
  return new Request("https://control.example.com/api/auth/mobile/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeMobileAuthorizationCode.mockResolvedValue({
    codeChallenge: RFC_CHALLENGE,
    oneTimeToken: "one-time-token",
  });
  mocks.verifyOneTimeToken.mockResolvedValue({
    session: {
      token: "session-token",
      expiresAt: new Date("2026-08-08T12:00:00.000Z"),
    },
    user: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      image: null,
    },
  });
});

describe("mobile PKCE redemption", () => {
  test("exchanges a matching verifier for the Better Auth session", async () => {
    const response = await POST(
      request({ code: CODE, code_verifier: RFC_VERIFIER }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      token: "session-token",
      user: { id: "user-1", email: "test@example.com" },
    });
    expect(mocks.consumeMobileAuthorizationCode).toHaveBeenCalledWith(CODE);
    expect(mocks.verifyOneTimeToken).toHaveBeenCalledWith({
      body: { token: "one-time-token" },
    });
  });

  test("consumes but refuses a code when the verifier does not match", async () => {
    const response = await POST(
      request({ code: CODE, code_verifier: "z".repeat(43) }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_AUTHORIZATION_CODE" },
    });
    expect(mocks.consumeMobileAuthorizationCode).toHaveBeenCalledWith(CODE);
    expect(mocks.verifyOneTimeToken).not.toHaveBeenCalled();
  });

  test.each([
    ["missing code", { code_verifier: RFC_VERIFIER }],
    ["missing verifier", { code: CODE }],
    ["malformed verifier", { code: CODE, code_verifier: "short" }],
  ])("returns one generic error for %s", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_AUTHORIZATION_CODE",
        message: "The authorization code is invalid or expired.",
      },
    });
    expect(mocks.verifyOneTimeToken).not.toHaveBeenCalled();
  });

  test("refuses an expired or replayed code", async () => {
    mocks.consumeMobileAuthorizationCode.mockResolvedValue(null);

    const response = await POST(
      request({ code: CODE, code_verifier: RFC_VERIFIER }),
    );

    expect(response.status).toBe(400);
    expect(mocks.verifyOneTimeToken).not.toHaveBeenCalled();
  });

  test("does not reveal Better Auth verification failures", async () => {
    mocks.verifyOneTimeToken.mockRejectedValue(
      new Error("internal session lookup details"),
    );

    const response = await POST(
      request({ code: CODE, code_verifier: RFC_VERIFIER }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe(
      "The authorization code is invalid or expired.",
    );
    expect(JSON.stringify(body)).not.toContain(
      "internal session lookup details",
    );
  });
});
