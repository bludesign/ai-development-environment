import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import { copyText } from "@/lib/browser-utils";

import { ToolsPage } from "./tools-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));
vi.mock("@/lib/browser-utils", () => ({
  copyText: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const copyTextMock = vi.mocked(copyText);

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  copyTextMock.mockReset();
  vi.unstubAllGlobals();
});

describe("ToolsPage", () => {
  test("switches to a searchable tool call audit table", async () => {
    let cleared = false;
    requestMock.mockImplementation(async (query) => {
      if (query.includes("mutation ClearToolCallAudits")) {
        cleared = true;
        return { clearToolCallAudits: { count: 1 } } as never;
      }
      if (query.includes("query ToolCallAudits")) {
        return {
          toolCallAudits: cleared
            ? []
            : [
                {
                  id: "audit-1",
                  correlationId: "correlation-1",
                  caller: "runner-1",
                  source: "WORKFLOW",
                  groupId: "builtin:codebases",
                  toolName: "get_codebase",
                  argumentsSha256:
                    "807074c963aab9d3d09b49b6056652a6b05b1f1e88066dbac57e2a03658be3dc",
                  resultStatus: "SUCCEEDED",
                  durationMs: 42,
                  startedAt: "2026-07-26T12:00:00.000Z",
                  finishedAt: "2026-07-26T12:00:00.042Z",
                },
              ],
        } as never;
      }
      return { externalMcpServers: [] } as never;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ groups: [] })),
    );

    render(<ToolsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Audit" }));

    expect(await screen.findByText("get_codebase")).toBeDefined();
    expect(screen.getByText("Succeeded")).toBeDefined();
    expect(screen.getByText("Workflow")).toBeDefined();
    expect(screen.getByText("42 ms")).toBeDefined();
    expect(screen.getByTitle("correlation-1")).toBeDefined();
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringContaining("toolCallAudits(first: 200)"),
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search tool call audit" }),
      { target: { value: "no-match" } },
    );
    expect(screen.queryByText("get_codebase")).toBeNull();
    expect(
      screen.getByText("No audit records match the search."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Clear audit" }));
    expect(
      await screen.findByText(
        "Delete all completed tool-call audit records? Calls currently running will be preserved.",
      ),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete audit records" }),
    );

    expect(
      await screen.findByText("No tool calls have been audited."),
    ).toBeDefined();
    expect(requestMock).toHaveBeenCalledWith(
      "mutation ClearToolCallAudits { clearToolCallAudits { count } }",
    );
  });

  test("searches, expands, runs a tool, and renders its response", async () => {
    requestMock.mockResolvedValue({ externalMcpServers: [] } as never);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/tools/catalog")) {
        return Response.json({
          groups: [
            {
              id: "builtin:codebases",
              name: "Codebases",
              source: "BUILTIN",
              transport: null,
              url: null,
              error: null,
              tools: [
                {
                  name: "get_codebase",
                  title: "Get codebase",
                  description: "Get a codebase by path.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      path: {
                        type: "string",
                        description: "Exact folder path",
                      },
                    },
                    required: ["path"],
                  },
                  outputSchema: null,
                },
              ],
            },
          ],
        });
      }
      return Response.json({
        result: {
          structuredContent: { codebase: { path: "/work/repo" } },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ToolsPage />);
    await screen.findByText("get_codebase");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
      target: { value: "missing-tool" },
    });
    expect(screen.queryByText("get_codebase")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
      target: { value: "codebase" },
    });

    const toolRow = await screen.findByRole("button", {
      name: "Expand get_codebase",
    });
    fireEvent.click(screen.getByText("Get a codebase by path."));
    expect(toolRow.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(toolRow, { key: " " });
    expect(toolRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(toolRow, { key: "Enter" });
    expect(toolRow.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByLabelText(/path/), {
      target: { value: "/work/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));

    expect(await screen.findByText(/\/work\/repo/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    await waitFor(() =>
      expect(copyTextMock).toHaveBeenCalledWith(
        JSON.stringify(
          {
            structuredContent: { codebase: { path: "/work/repo" } },
          },
          null,
          2,
        ),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Response copied" }),
    ).toBeDefined();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tools/call",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "content-type": "application/json",
          }),
        }),
      );
    });
  });

  test("runs a tool with dynamic root arguments from a JSON object editor", async () => {
    requestMock.mockResolvedValue({ externalMcpServers: [] } as never);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/tools/catalog")) {
          return Response.json({
            groups: [
              {
                id: "external:dynamic",
                name: "Dynamic server",
                source: "EXTERNAL",
                transport: "STREAMABLE_HTTP",
                url: "https://example.com/mcp",
                error: null,
                tools: [
                  {
                    name: "dynamic_lookup",
                    title: "Dynamic lookup",
                    description: "Looks up dynamic fields.",
                    inputSchema: {
                      type: "object",
                      additionalProperties: { type: "string" },
                    },
                    outputSchema: null,
                  },
                ],
              },
            ],
          });
        }
        expect(JSON.parse(String(init?.body))).toMatchObject({
          groupId: "external:dynamic",
          name: "dynamic_lookup",
          arguments: { region: "us-east" },
        });
        expect(init?.headers).toEqual({
          "content-type": "application/json",
        });
        return Response.json({ result: { found: true } });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ToolsPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand dynamic_lookup" }),
    );
    const editor = screen.getByLabelText("Arguments (JSON object)");
    expect((editor as HTMLTextAreaElement).value).toBe("{}");
    fireEvent.change(editor, {
      target: { value: '{"region":"us-east"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));

    expect(await screen.findByText(/"found": true/)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tools/call",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("requires explicit confirmation before a destructive tool call", async () => {
    requestMock.mockResolvedValue({ externalMcpServers: [] } as never);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/tools/catalog")) {
        return Response.json({
          groups: [
            {
              id: "builtin:danger",
              name: "Danger",
              source: "BUILTIN",
              transport: null,
              url: null,
              error: null,
              children: [],
              tools: [
                {
                  name: "delete_everything",
                  title: "Delete everything",
                  description: "Deletes data.",
                  inputSchema: { type: "object", properties: {} },
                  outputSchema: null,
                  annotations: {
                    readOnlyHint: false,
                    destructiveHint: true,
                    idempotentHint: true,
                    openWorldHint: false,
                  },
                },
              ],
            },
          ],
        });
      }
      return Response.json({ result: { deleted: true } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ToolsPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand delete_everything" }),
    );
    expect(screen.getByText("Destructive")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Run a destructive tool?")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Run destructive tool" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test("renders, searches, counts, and invokes nested built-in groups", async () => {
    requestMock.mockResolvedValue({ externalMcpServers: [] } as never);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/tools/catalog")) {
          return Response.json({
            groups: [
              {
                id: "builtin:debugging",
                name: "Debugging",
                source: "BUILTIN",
                transport: null,
                url: null,
                error: null,
                tools: [
                  {
                    name: "get_unified_events",
                    title: "Get unified events",
                    description: "Fetch unified events.",
                    inputSchema: { type: "object", properties: {} },
                    outputSchema: null,
                  },
                ],
                children: [
                  {
                    id: "builtin:debugging:console-logs",
                    name: "Console Logs",
                    source: "BUILTIN",
                    transport: null,
                    url: null,
                    error: null,
                    tools: [
                      {
                        name: "get_console_logs",
                        title: "Get console logs",
                        description: "Fetch console logs.",
                        inputSchema: { type: "object", properties: {} },
                        outputSchema: null,
                      },
                    ],
                    children: [],
                  },
                ],
              },
            ],
          });
        }
        expect(JSON.parse(String(init?.body))).toMatchObject({
          groupId: "builtin:debugging:console-logs",
          name: "get_console_logs",
          arguments: {},
        });
        return Response.json({ result: { items: [] } });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ToolsPage />);
    await screen.findByText("get_console_logs");
    expect(screen.getByText("get_unified_events")).toBeDefined();
    expect(screen.getByText("Debugging")).toBeDefined();
    expect(screen.getByText("Console Logs")).toBeDefined();
    expect(screen.getAllByText("2 tools")).toHaveLength(1);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
      target: { value: "console logs" },
    });
    expect(screen.queryByText("get_unified_events")).toBeNull();
    expect(screen.getByText("get_console_logs")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand get_console_logs" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tools/call",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  test("creates an external server with write-only headers", async () => {
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("query ExternalMcpServers")) {
        return { externalMcpServers: [] } as never;
      }
      if (query.includes("CreateExternalMcpServer")) {
        expect(variables).toMatchObject({
          input: {
            name: "Example",
            url: "https://example.com/mcp",
            transport: "STREAMABLE_HTTP",
            headers: [
              {
                name: "Authorization",
                value: "Bearer secret",
              },
            ],
          },
        });
        return { createExternalMcpServer: { id: "server-1" } } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ groups: [] })),
    );

    render(<ToolsPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add MCP server" }),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Example" },
    });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByLabelText("Header name"), {
      target: { value: "Authorization" },
    });
    fireEvent.change(screen.getByLabelText("Header value"), {
      target: { value: "Bearer secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("CreateExternalMcpServer"),
        expect.any(Object),
      ),
    );
    expect(screen.queryByDisplayValue("Bearer secret")).toBeNull();
  });

  test("shows the built-in MCP endpoint and copies its client configuration", async () => {
    requestMock.mockResolvedValue({ externalMcpServers: [] } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ groups: [] })),
    );

    render(<ToolsPage />);

    const url = `${window.location.origin}/api/mcp`;
    expect(await screen.findByText(url)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Copy server URL" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith(url));
    expect(screen.getAllByRole("button", { name: "Copied" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy configuration" }));
    await waitFor(() =>
      expect(copyTextMock).toHaveBeenCalledWith(
        JSON.stringify(
          {
            mcpServers: {
              "ai-development-environment": {
                type: "http",
                url,
                headers: {
                  "X-API-Key": "<AIDE_API_KEY>",
                },
              },
            },
          },
          null,
          2,
        ),
      ),
    );
  });

  test("reports a failed clipboard write on the connect card", async () => {
    requestMock.mockResolvedValue({ externalMcpServers: [] } as never);
    copyTextMock.mockRejectedValue(new Error("denied"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ groups: [] })),
    );

    render(<ToolsPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy server URL" }),
    );

    expect(
      await screen.findByText("Could not copy to the clipboard."),
    ).toBeDefined();
  });
});
