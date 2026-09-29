import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callSnapshotTool: vi.fn(),
  mcpPresetSnapshot: vi.fn(),
}));

vi.mock("@/services/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tools")>()),
  authorizeMcpPresetRequest: vi.fn().mockResolvedValue({
    context: {
      caller: "api-key:test",
      correlationId: "request-cancellation",
      source: "MCP",
    },
  }),
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ toolsService: mocks }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mcpPresetSnapshot.mockResolvedValue({
    schemaVersion: 1,
    tools: [
      {
        name: "aide_ext_0123456789abcdef_search",
        inputSchema: { type: "object" },
        outputSchema: null,
        annotations: null,
        title: null,
        description: null,
        reference: { source: "EXTERNAL", serverId: "server-1", name: "search" },
      },
    ],
  });
});

describe("scoped MCP HTTP cancellation", () => {
  test("aborting the HTTP request cancels the active external invocation", async () => {
    let finish!: () => void;
    mocks.callSnapshotTool.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ content: [{ type: "text", text: "Stopped" }] });
        }),
    );
    const controller = new AbortController();
    const response = await POST(
      new Request("https://control.example/api/mcp?preset=preset-1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "aide_ext_0123456789abcdef_search", arguments: {} },
        }),
        signal: controller.signal,
      }),
    );
    try {
      expect(response.status).toBe(200);
      await vi.waitFor(() =>
        expect(mocks.callSnapshotTool).toHaveBeenCalledOnce(),
      );
      const invocationSignal = mocks.callSnapshotTool.mock
        .calls[0]![4] as AbortSignal;
      expect(invocationSignal.aborted).toBe(false);

      controller.abort();

      expect(invocationSignal.aborted).toBe(true);
    } finally {
      finish?.();
      await response.text();
    }
  });
});
