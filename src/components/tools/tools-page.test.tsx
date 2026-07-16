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
        expect.objectContaining({ method: "POST" }),
      );
    });
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
});
