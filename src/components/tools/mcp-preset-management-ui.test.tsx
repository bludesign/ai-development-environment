import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { ToolCatalogSummaryGroup } from "@/services/tools/types";

import { McpPresetManagement } from "./mcp-preset-management";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
afterEach(() => {
  cleanup();
  request.mockReset();
  vi.unstubAllGlobals();
});

test("editing keeps unavailable selections and distinguishes the same upstream name on different servers", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const preset = {
    id: "mixed",
    name: "Mixed",
    description: "",
    iconKey: "wrench",
    enabledForPlans: true,
    enabledForSessions: true,
    toolNames: [],
    tools: [
      {
        source: "EXTERNAL",
        serverId: "one",
        serverName: "Server One",
        name: "search",
      },
      {
        source: "EXTERNAL",
        serverId: "offline",
        serverName: "Offline",
        name: "old_tool",
      },
    ],
    createdAt: "",
    updatedAt: "",
  };
  request.mockResolvedValue({ mcpToolPresets: [preset] } as never);
  const groups = ["one", "two"].map((id) => ({
    id: `external:${id}`,
    name: `Server ${id}`,
    source: "EXTERNAL",
    url: null,
    transport: "STREAMABLE_HTTP",
    error: null,
    children: [],
    tools: [
      {
        name: "search",
        title: `Search ${id}`,
        description: "",
        annotations: null,
        reference: { source: "EXTERNAL", serverId: id, name: "search" },
      },
    ],
  })) as ToolCatalogSummaryGroup[];
  render(
    <McpPresetManagement
      baseMcpUrl="https://example.com/api/mcp"
      groups={groups}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit preset" }));
  expect(screen.getByText(/Offline \/ old_tool/)).toBeDefined();
  expect(
    screen
      .getByRole("checkbox", { name: "Server one: Search one" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  const other = screen.getByRole("checkbox", {
    name: "Server two: Search two",
  });
  expect(other.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(other);
  fireEvent.click(screen.getByRole("button", { name: "Remove old_tool" }));
  fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation UpdateMcpToolPreset"),
      {
        id: "mixed",
        input: {
          name: "Mixed",
          description: "",
          iconKey: "wrench",
          enabledForPlans: true,
          enabledForSessions: true,
          tools: [
            { source: "EXTERNAL", serverId: "one", name: "search" },
            { source: "EXTERNAL", serverId: "two", name: "search" },
          ],
        },
      },
    ),
  );
});
