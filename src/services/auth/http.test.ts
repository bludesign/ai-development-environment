import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PrincipalResolutionError extends Error {}
  return {
    PrincipalResolutionError,
    requireUserPrincipal: vi.fn(),
    principalErrorResponse: vi.fn(),
  };
});

vi.mock("./principal", () => ({
  PrincipalResolutionError: mocks.PrincipalResolutionError,
  requireUserPrincipal: mocks.requireUserPrincipal,
  principalErrorResponse: mocks.principalErrorResponse,
}));

import { requireUserRequest } from "./http";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("protected REST requests", () => {
  test("continues after a valid user session", async () => {
    mocks.requireUserPrincipal.mockResolvedValue({ kind: "user" });

    await expect(
      requireUserRequest(new Request("https://control.example.com/api/test")),
    ).resolves.toBeNull();
  });

  test("returns the principal error response before route execution", async () => {
    const error = new mocks.PrincipalResolutionError("Authentication required");
    const denial = Response.json(
      { error: "Authentication required" },
      { status: 401 },
    );
    mocks.requireUserPrincipal.mockRejectedValue(error);
    mocks.principalErrorResponse.mockReturnValue(denial);

    await expect(
      requireUserRequest(new Request("https://control.example.com/api/test")),
    ).resolves.toBe(denial);
  });
});
