import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { ToolCatalogSummaryGroup } from "@/services/tools/types";
import {
  mcpPresetJsonSchema,
  parseMcpPresetDocument,
} from "@/services/tools/mcp-preset-format";

import {
  McpCatalogExport,
  McpPresetImportDialog,
  type McpImportPreview,
} from "./mcp-preset-transfer";
import {
  catalogSelections,
  presetToolInput,
  toolReferenceKey,
} from "./mcp-tool-selection";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function selectOption(label: string, option: string) {
  fireEvent.keyDown(screen.getByLabelText(label), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: option }));
}
const document = JSON.stringify({
  format: "aide.mcp-presets.export",
  schemaVersion: 1,
  externalServers: [{ key: "server-1", name: "Search MCP" }],
  presets: [
    {
      name: "Research",
      description: "Investigate",
      iconKey: "wrench",
      enabledForPlans: true,
      enabledForSessions: true,
      tools: [{ source: "EXTERNAL", serverKey: "server-1", name: "search" }],
    },
  ],
});
const preview: McpImportPreview = {
  token: "review-1",
  canImport: false,
  errors: [],
  entries: [
    {
      index: 0,
      name: "Research",
      action: "CREATE",
      targetId: null,
      toolCount: 1,
      errors: ["Map server-1"],
      warnings: [],
    },
  ],
  externalServers: [
    {
      key: "server-1",
      name: "Search MCP",
      transport: null,
      selectedServerId: null,
      suggestedServerId: "local",
      candidates: [{ id: "local", name: "Search MCP" }],
    },
  ],
};
const preset = {
  id: "existing",
  name: "Existing",
  description: "",
  iconKey: "wrench",
  enabledForPlans: true,
  enabledForSessions: true,
  toolNames: [],
  createdAt: "",
  updatedAt: "",
};
function renderImport(onImported = vi.fn().mockResolvedValue(undefined)) {
  render(
    <McpPresetImportDialog
      open
      onOpenChange={vi.fn()}
      presets={[preset]}
      onImported={onImported}
    />,
  );
  fireEvent.change(screen.getByLabelText("Preset JSON"), {
    target: { value: document },
  });
  return onImported;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  request.mockReset();
  vi.unstubAllGlobals();
});

describe("portable MCP preset review", () => {
  test("requires explicit mapping and a fresh review, then applies the reviewed input", async () => {
    request.mockImplementation(async (query, variables) => {
      if (query.includes("query Preview")) {
        const mapped = Boolean(
          (variables as { input: { serverMappings: unknown[] } }).input
            .serverMappings.length,
        );
        return {
          previewMcpToolPresetImport: {
            ...preview,
            token: mapped ? "review-2" : "review-1",
            canImport: mapped,
          },
        } as never;
      }
      return { importMcpToolPresets: [{ id: "new" }] } as never;
    });
    const onImported = renderImport();
    const apply = screen.getByRole("button", {
      name: "Import reviewed presets",
    });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    const mapping = await screen.findByLabelText(
      "Map Search MCP to a configured server",
    );
    expect(mapping.textContent).toContain("Choose a server");
    selectOption(
      "Map Search MCP to a configured server",
      "Search MCP (suggested)",
    );
    expect(
      screen.getByText("Selections changed. Review again before importing."),
    ).toBeDefined();
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await waitFor(() =>
      expect((apply as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(apply);
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(request).toHaveBeenLastCalledWith(
      expect.stringContaining("mutation ImportMcpToolPresets"),
      {
        input: {
          document,
          decisions: [],
          serverMappings: [{ serverKey: "server-1", serverId: "local" }],
        },
        previewToken: "review-2",
      },
    );
  });

  test("changing a conflict decision invalidates review and preserves the replacement ID", async () => {
    request.mockResolvedValue({
      previewMcpToolPresetImport: {
        ...preview,
        externalServers: [],
        canImport: true,
      },
    } as never);
    renderImport();
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await screen.findByLabelText("Import action");
    selectOption("Import action", "Replace existing preset");
    selectOption("Preset to replace", "Existing");
    expect(
      (
        screen.getByRole("button", {
          name: "Import reviewed presets",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][1]).toMatchObject({
      input: {
        decisions: [{ index: 0, action: "REPLACE", targetId: "existing" }],
      },
    });
    fireEvent.change(screen.getByLabelText("Preset JSON"), {
      target: { value: document + " " },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Import reviewed presets",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByLabelText("Import action")).toBeNull();
  });

  test("a failed import preserves the JSON and requires another review", async () => {
    request
      .mockResolvedValueOnce({
        previewMcpToolPresetImport: {
          ...preview,
          externalServers: [],
          canImport: true,
        },
      } as never)
      .mockRejectedValueOnce(new Error("Review changed. Review again."));
    renderImport();
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Import reviewed presets",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed presets" }),
    );
    expect(
      await screen.findByText("Review changed. Review again."),
    ).toBeDefined();
    expect(
      (screen.getByLabelText("Preset JSON") as HTMLTextAreaElement).value,
    ).toBe(document);
    expect(
      (
        screen.getByRole("button", {
          name: "Import reviewed presets",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("reads selected and dropped JSON files and rejects oversized files before reading", async () => {
    renderImport();
    const file = new File([document], "preset.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", { value: async () => document + " " });
    fireEvent.change(screen.getByLabelText("Preset JSON file"), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Preset JSON") as HTMLTextAreaElement).value,
      ).toBe(document + " "),
    );
    const dropped = new File([document], "dropped.json", {
      type: "application/json",
    });
    Object.defineProperty(dropped, "text", { value: async () => document });
    fireEvent.drop(
      screen.getByText("Drop a JSON file here or click to browse."),
      {
        dataTransfer: { files: [dropped] },
      },
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Preset JSON") as HTMLTextAreaElement).value,
      ).toBe(document),
    );
    const oversized = new File([], "large.json");
    const read = vi.fn();
    Object.defineProperties(oversized, {
      size: { value: 2 * 1024 * 1024 + 1 },
      text: { value: read },
    });
    fireEvent.change(screen.getByLabelText("Preset JSON file"), {
      target: { files: [oversized] },
    });
    expect(
      await screen.findByText("Preset JSON must be 2 MiB or smaller."),
    ).toBeDefined();
    expect(read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("catalog portability", () => {
  test("requests a full server-generated export with selected category filters", async () => {
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:catalog"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    request.mockResolvedValue({
      exportMcpToolCatalog: {
        filename: "tools.md",
        contentType: "text/markdown",
        content: "# Tools",
      },
    } as never);
    render(
      <McpCatalogExport
        groups={[
          {
            id: "builtin:codebases",
            name: "Codebases",
            source: "BUILTIN",
            tools: [],
            children: [],
            error: null,
            url: null,
            transport: null,
          },
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export tool catalog" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Codebases" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("query ExportMcpToolCatalog"),
      { format: "MARKDOWN", source: "ALL", groupIds: ["builtin:codebases"] },
    );
  });

  test("shadcn format and source dropdowns export the chosen values", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:catalog"),
    });
    request.mockResolvedValue({
      exportMcpToolCatalog: {
        filename: "tools.json",
        contentType: "application/json",
        content: "{}",
      },
    } as never);
    render(<McpCatalogExport groups={[]} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Export tool catalog" }),
    );
    selectOption("Format", "JSON");
    selectOption("Tool sources", "External tools");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("query ExportMcpToolCatalog"),
        { format: "JSON", source: "EXTERNAL", groupIds: null },
      ),
    );
  });

  test("keeps external identities distinct and excludes display metadata from mutations", () => {
    const first = {
      source: "EXTERNAL" as const,
      serverId: "one",
      serverName: "One",
      name: "search",
    };
    const second = { ...first, serverId: "two" };
    expect(toolReferenceKey(first)).not.toBe(toolReferenceKey(second));
    expect(toolReferenceKey(first)).toBe(
      toolReferenceKey({ ...first, serverName: "Renamed" }),
    );
    expect(presetToolInput(first)).toEqual({
      source: "EXTERNAL",
      serverId: "one",
      name: "search",
    });
    const group = {
      id: "external:one",
      name: "One",
      source: "EXTERNAL",
      children: [],
      tools: [{ name: "prefix_search", reference: first }],
    } as unknown as ToolCatalogSummaryGroup;
    expect(catalogSelections(group)[0].reference.name).toBe("search");
  });
});

describe("AI import instructions", () => {
  test("expands and copies a prompt with a valid example and the authoritative schema", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderImport();
    const trigger = screen.getByRole("button", {
      name: "Prompt for an AI to create presets",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const prompt = (
      screen.getByLabelText(
        "AI preset generation prompt",
      ) as HTMLTextAreaElement
    ).value;
    expect(prompt).toContain("[describe your task and constraints]");
    const [example, schema] = prompt
      .split(
        "Example document (use only tools present in the attached catalog):\n\n",
      )[1]
      .split("\n\nRequired JSON Schema:\n\n");
    expect(parseMcpPresetDocument(example).presets[0].tools).toEqual([
      { source: "BUILTIN", name: "get_codebases" },
    ]);
    expect(JSON.parse(schema)).toEqual(mcpPresetJsonSchema());
    fireEvent.click(screen.getByRole("button", { name: "Copy AI prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt));
    expect(
      await screen.findByRole("button", { name: "Prompt copied" }),
    ).toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

  test("keeps the prompt selectable when clipboard access fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    renderImport();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Prompt for an AI to create presets",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy AI prompt" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Select and copy it manually",
    );
    expect(
      (
        screen.getByLabelText(
          "AI preset generation prompt",
        ) as HTMLTextAreaElement
      ).readOnly,
    ).toBe(true);
  });
});
