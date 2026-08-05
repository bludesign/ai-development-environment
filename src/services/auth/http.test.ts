import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PrincipalResolutionError extends Error {}
  return {
    PrincipalResolutionError,
    requireUserPrincipal: vi.fn(),
    principalErrorResponse: vi.fn(),
    usesAmbientCredential: vi.fn(),
  };
});

vi.mock("./principal", () => ({
  PrincipalResolutionError: mocks.PrincipalResolutionError,
  requireUserPrincipal: mocks.requireUserPrincipal,
  principalErrorResponse: mocks.principalErrorResponse,
  usesAmbientCredential: mocks.usesAmbientCredential,
}));

import { crossOriginError, requireUserRequest } from "./http";

const origin = "https://control.example.com";
const url = `${origin}/api/test`;

function request(headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default to a token-authenticated caller so the origin guard stays out of the
  // way of the tests that are about principal resolution.
  mocks.usesAmbientCredential.mockReturnValue(false);
});

describe("protected REST requests", () => {
  test("continues after a valid user session", async () => {
    mocks.requireUserPrincipal.mockResolvedValue({ kind: "user" });

    await expect(requireUserRequest(request())).resolves.toBeNull();
  });

  test("returns the principal error response before route execution", async () => {
    const error = new mocks.PrincipalResolutionError("Authentication required");
    const denial = Response.json(
      { error: "Authentication required" },
      { status: 401 },
    );
    mocks.requireUserPrincipal.mockRejectedValue(error);
    mocks.principalErrorResponse.mockReturnValue(denial);

    await expect(requireUserRequest(request())).resolves.toBe(denial);
  });
});

describe("cross-origin guard on cookie-authenticated requests", () => {
  test("ignores requests that carry a deliberate credential", () => {
    mocks.usesAmbientCredential.mockReturnValue(false);

    expect(
      crossOriginError(
        request({
          "sec-fetch-site": "cross-site",
          origin: "https://evil.test",
        }),
      ),
    ).toBeNull();
  });

  test.each([
    ["same-origin fetch", { "sec-fetch-site": "same-origin" }],
    ["user-initiated navigation", { "sec-fetch-site": "none" }],
    ["a matching Origin without Sec-Fetch-Site", { origin }],
    ["a non-browser client that sends neither header", {}],
  ])("allows %s", (_label, headers) => {
    mocks.usesAmbientCredential.mockReturnValue(true);

    expect(crossOriginError(request(headers))).toBeNull();
  });

  test.each([
    ["a cross-site request", { "sec-fetch-site": "cross-site" }],
    ["a sibling subdomain", { "sec-fetch-site": "same-site" }],
    [
      "a foreign Origin without Sec-Fetch-Site",
      { origin: "https://evil.test" },
    ],
    ["an opaque Origin", { origin: "null" }],
  ])("refuses %s with 403", (_label, headers) => {
    mocks.usesAmbientCredential.mockReturnValue(true);

    expect(crossOriginError(request(headers))?.status).toBe(403);
  });

  test("runs before the principal is resolved", async () => {
    mocks.usesAmbientCredential.mockReturnValue(true);

    const denied = await requireUserRequest(
      request({ "sec-fetch-site": "cross-site" }),
    );

    expect(denied?.status).toBe(403);
    expect(mocks.requireUserPrincipal).not.toHaveBeenCalled();
  });
});
