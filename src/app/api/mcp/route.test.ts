import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callBuiltInTool: vi.fn(),
  callRunBuiltInTool: vi.fn(),
  mcpRunToolNames: vi.fn(),
  mcpPresetToolNames: vi.fn().mockResolvedValue(null),
  builtInTools: { definitions: () => [] },
}));
const authorization = vi.hoisted(() => ({
  authorizeMcpPresetRequest: vi.fn(),
  authorizeRunMcpRequest: vi.fn(),
  authorizeToolRequest: vi.fn(),
}));

vi.mock("@/services/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tools")>()),
  ...authorization,
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    agentControlService: {},
    toolsService: mocks,
  }),
}));

import { DELETE, GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  const allowed = {
    context: {
      caller: "api-key:key-1@unknown",
      correlationId: "request-1",
      source: "MCP",
    },
  };
  authorization.authorizeMcpPresetRequest.mockResolvedValue(allowed);
  authorization.authorizeToolRequest.mockResolvedValue(allowed);
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

  test("allows an authorized API key for preset URLs", async () => {
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
    "allows authorized unscoped requests",
    async (handler) => {
      const response = await handler(
        new Request("https://control.example/api/mcp", { method: "POST" }),
      );
      expect([401, 503]).not.toContain(response.status);
    },
  );

  test("rejects invalid credentials", async () => {
    authorization.authorizeToolRequest.mockResolvedValueOnce({
      response: Response.json(
        { error: { message: "Unauthorized" } },
        { status: 401 },
      ),
    });
    const response = await POST(
      new Request("https://control.example/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer incorrect" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
