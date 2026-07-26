import { afterEach, describe, expect, test, vi } from "vitest";

import { GET, POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MCP endpoint authentication", () => {
  test.each([GET, POST])(
    "rejects requests before starting an MCP transport when no token is configured",
    async (handler) => {
      vi.stubEnv("TOOLS_API_TOKEN", "");
      const response = await handler(
        new Request("https://control.example/api/mcp", { method: "POST" }),
      );
      expect(response.status).toBe(503);
    },
  );

  test("rejects an invalid bearer token", async () => {
    vi.stubEnv("TOOLS_API_TOKEN", "deployment-secret");
    const response = await POST(
      new Request("https://control.example/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer incorrect" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
