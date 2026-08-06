import { afterEach, describe, expect, test, vi } from "vitest";

import { authManagementRequest } from "./auth-management-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authManagementRequest", () => {
  test("returns a successful JSON response", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      authManagementRequest<{ success: boolean }>("api-keys"),
    ).resolves.toEqual({ success: true });
    expect(fetch).toHaveBeenCalledWith("/api/auth/management/api-keys", {
      credentials: "same-origin",
      headers: {},
    });
  });

  test("uses the API error message from a failed JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: "API-key expiration is invalid." } },
            { status: 400 },
          ),
        ),
    );

    await expect(authManagementRequest("api-keys")).rejects.toThrow(
      "API-key expiration is invalid.",
    );
  });

  test("reports the HTTP status when a failed response is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );

    await expect(authManagementRequest("api-keys")).rejects.toThrow("HTTP 500");
  });

  test("reports invalid JSON without leaking the parser exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not-json", { status: 502 })),
    );

    await expect(authManagementRequest("api-keys")).rejects.toThrow("HTTP 502");
  });
});
