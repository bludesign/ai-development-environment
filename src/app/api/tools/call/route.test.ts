import { beforeEach, describe, expect, test, vi } from "vitest";

import { CommandPortConflictError } from "@/services/commands";

const authorizeToolRequest = vi.hoisted(() => vi.fn());
const callTool = vi.hoisted(() => vi.fn());

vi.mock("@/services/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tools")>()),
  authorizeToolRequest,
}));
vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ toolsService: { callTool } }),
}));

import { POST } from "./route";

beforeEach(() => {
  callTool.mockReset();
  authorizeToolRequest.mockResolvedValue({
    context: {
      caller: "user:user-1@unknown",
      correlationId: "request-1",
      source: "TOOLS_PAGE",
    },
  });
});

describe("tool-call endpoint authentication", () => {
  test("parses tool calls after user-session authorization", async () => {
    const response = await POST(
      new Request("https://control.example/api/tools/call", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(400);
  });

  test("rejects an invalid session before parsing the call", async () => {
    authorizeToolRequest.mockResolvedValueOnce({
      response: Response.json(
        { error: { message: "Unauthorized" } },
        { status: 401 },
      ),
    });
    const response = await POST(
      new Request("https://control.example/api/tools/call", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  test("returns the command port conflict IDs in an HTTP conflict response", async () => {
    const portConflict = {
      agentId: "agent-1",
      agentName: "Builder",
      port: 3000,
      runs: [
        { id: "run-1", displayNumber: 1, name: "Preview", status: "RUNNING" },
      ],
    };
    const failure = new CommandPortConflictError(portConflict);
    callTool.mockRejectedValueOnce(failure);
    const response = await POST(
      new Request("https://control.example/api/tools/call", {
        method: "POST",
        body: JSON.stringify({
          groupId: "builtin:commands",
          name: "start_command",
          arguments: { commandId: "preview", agentId: "agent-1" },
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-request-id")).toBe("request-1");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "COMMAND_PORT_CONFLICT",
        message: failure.message,
        portConflict,
      },
    });
  });
});
