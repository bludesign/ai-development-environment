import { beforeEach, describe, expect, test, vi } from "vitest";

const authorizeToolRequest = vi.hoisted(() => vi.fn());

vi.mock("@/services/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tools")>()),
  authorizeToolRequest,
}));

import { POST } from "./route";

beforeEach(() => {
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
});
