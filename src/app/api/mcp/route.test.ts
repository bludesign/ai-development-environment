import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callBuiltInTool: vi.fn(),
  mcpPresetToolNames: vi.fn().mockResolvedValue(null),
  builtInTools: { definitions: () => [] },
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    agentControlService: {},
    toolsService: mocks,
  }),
}));

import { DELETE, GET, POST } from "./route";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("MCP endpoint authentication", () => {
  test("rejects mixed and duplicate scope query modes", async () => {
    await expect(
      POST(
        new Request(
          "https://control.example/api/mcp?preset=preset-1&run=run-1",
          { method: "POST" },
        ),
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      POST(
        new Request("https://control.example/api/mcp?preset=one&preset=two", {
          method: "POST",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
  });

  test("does not require authentication for preset URLs when no token is configured", async () => {
    vi.stubEnv("TOOLS_API_TOKEN", "");
    const response = await POST(
      new Request("https://control.example/api/mcp?preset=preset-1", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "MCP_PRESET_NOT_FOUND" },
    });
    expect(mocks.mcpPresetToolNames).toHaveBeenCalledWith("preset-1");
  });

  test.each([GET, POST, DELETE])(
    "does not require authentication when no token is configured",
    async (handler) => {
      vi.stubEnv("TOOLS_API_TOKEN", "");
      const response = await handler(
        new Request("https://control.example/api/mcp", { method: "POST" }),
      );
      expect([401, 503]).not.toContain(response.status);
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
