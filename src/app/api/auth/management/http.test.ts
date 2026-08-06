import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  crossOriginError: vi.fn(),
  requireUserPrincipal: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  crossOriginError: mocks.crossOriginError,
  PrincipalResolutionError: class PrincipalResolutionError extends Error {},
  principalErrorResponse: vi.fn(),
  requireUserPrincipal: mocks.requireUserPrincipal,
}));

import { authenticated } from "./http";

describe("authenticated", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.crossOriginError.mockReturnValue(null);
    mocks.requireUserPrincipal.mockResolvedValue({
      kind: "user",
      userId: "user-1",
      email: "user@example.com",
      sessionId: "session-1",
    });
  });

  test("returns JSON when an unexpected management action failure occurs", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const failure = new Error("database unavailable");

    const response = await authenticated(
      new Request("https://control.example.com/api/auth/management/api-keys"),
      async () => {
        throw failure;
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "The request could not be completed.",
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Auth management request failed:",
      failure,
    );
  });
});
