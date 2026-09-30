import { describe, expect, test, vi } from "vitest";
import { McpPresetTransferService } from "./mcp-preset-transfer.service";
import {
  MAX_MCP_IMPORT_BYTES,
  parseMcpPresetDocument,
} from "./mcp-preset-format";
import type { ToolsService } from "./tools.service";
import type { McpToolPresetView, ToolCatalogGroup } from "./types";

const preset = {
  name: "Reader",
  description: "Read codebases",
  iconKey: "wrench",
  enabledForPlans: true,
  enabledForSessions: true,
  tools: [{ source: "BUILTIN", name: "get_codebases" }],
};
const document = (presets = [preset], externalServers: unknown[] = []) =>
  JSON.stringify({
    format: "aide.mcp-presets.export",
    schemaVersion: 1,
    presets,
    externalServers,
  });
function setup() {
  const server = {
    id: "local-secret-id",
    name: "Example",
    transport: "STREAMABLE_HTTP",
    url: "https://example.test/mcp?token=secret",
    headers: [
      { id: "header-id", name: "Authorization", valueConfigured: true },
    ],
    toolNamePrefix: "example_",
    createdAt: "2026-09-29",
    updatedAt: "2026-09-29",
  };
  const catalog: ToolCatalogGroup[] = [
    {
      id: "builtin:codebases",
      name: "Codebases",
      source: "BUILTIN",
      transport: null,
      url: null,
      error: null,
      children: [],
      tools: [
        {
          name: "get_codebases",
          title: "Codebases",
          description: "List",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object" },
          annotations: null,
          reference: { source: "BUILTIN", name: "get_codebases" },
          available: true,
        },
      ],
    },
  ];
  const service = {
    mcpToolPresets: vi
      .fn<() => Promise<McpToolPresetView[]>>()
      .mockResolvedValue([]),
    externalServers: vi.fn().mockResolvedValue([server]),
    mcpPresetStateHash: vi.fn().mockResolvedValue("state-1"),
    catalog: vi.fn().mockResolvedValue({ groups: catalog }),
    normalizeMcpToolPresetInput: vi.fn().mockImplementation(async (input) => {
      if (input.tools.some((ref: { name: string }) => ref.name === "unknown"))
        throw new Error("Unknown built-in tool: unknown");
      return input;
    }),
    resolveMcpToolReferences: vi
      .fn()
      .mockImplementation(async (refs, _discovery?: unknown) => ({
        schemaVersion: 1,
        tools: refs.map((reference: unknown) => ({
          reference,
          endpointHash: "endpoint-1",
        })),
      })),
    importMcpToolPresetBatch: vi.fn().mockResolvedValue([{ id: "created" }]),
  };
  return {
    server,
    catalog,
    service,
    transfer: new McpPresetTransferService(service as unknown as ToolsService),
  };
}

describe("portable MCP presets", () => {
  test("strictly validates document format, size, fields, and normalized duplicate references", () => {
    expect(() => parseMcpPresetDocument("not json")).toThrow("valid JSON");
    expect(() =>
      parseMcpPresetDocument(" ".repeat(2 * 1024 * 1024 + 1)),
    ).toThrow("2 MiB");
    expect(() =>
      parseMcpPresetDocument(
        document().replace('"schemaVersion":1', '"schemaVersion":2'),
      ),
    ).toThrow("schemaVersion");
    expect(() =>
      parseMcpPresetDocument(
        document([
          {
            ...preset,
            tools: [
              { source: "BUILTIN", name: "get_codebases" },
              { source: "BUILTIN", name: " get_codebases " },
            ],
          },
        ]),
      ),
    ).toThrow("duplicate");
    expect(() =>
      parseMcpPresetDocument(document([{ ...preset, iconKey: "invalid" }])),
    ).toThrow("iconKey");
    expect(() =>
      parseMcpPresetDocument(
        document().replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"credentials":"secret"',
        ),
      ),
    ).toThrow("Unrecognized key");
  });

  test("requires explicit existing-server mappings and accepts name-only portable hints", async () => {
    const { transfer, service, server } = setup();
    const input = {
      document: document(
        [
          {
            ...preset,
            tools: [
              {
                source: "EXTERNAL",
                name: "search",
                serverKey: "remote",
              } as never,
            ],
          },
        ],
        [{ key: "remote", name: "Example" }],
      ),
    };
    const initial = await transfer.preview(input);
    expect(initial.canImport).toBe(false);
    expect(initial.externalServers[0]).toMatchObject({
      selectedServerId: null,
      suggestedServerId: server.id,
      transport: null,
    });
    expect(initial.entries[0]!.errors[0]).toContain("Map external server");
    const mapped = {
      ...input,
      serverMappings: [{ serverKey: "remote", serverId: server.id }],
    };
    const preview = await transfer.preview(mapped);
    expect(preview.canImport).toBe(true);
    await transfer.import(mapped, preview.token);
    expect(service.importMcpToolPresetBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          targetId: null,
          input: expect.objectContaining({
            tools: [
              { source: "EXTERNAL", name: "search", serverId: server.id },
            ],
          }),
        }),
      ],
      "state-1",
      [{ serverId: server.id, endpointHash: "endpoint-1" }],
    );
  });

  test("reviews create/replace/skip, names, missing tools, and changed previews before any writes", async () => {
    const { transfer, service } = setup();
    service.mcpToolPresets.mockResolvedValue([
      {
        ...preset,
        id: "preset-1",
        toolNames: ["get_codebases"],
        createdAt: "now",
        updatedAt: "now",
      } as McpToolPresetView,
    ]);
    const collision = await transfer.preview({ document: document() });
    expect(collision.canImport).toBe(false);
    const input = {
      document: document([
        preset,
        {
          ...preset,
          name: "Unused",
          tools: [{ source: "BUILTIN", name: "unknown" }],
        },
      ]),
      decisions: [
        { index: 0, action: "REPLACE" as const, targetId: "preset-1" },
        { index: 1, action: "SKIP" as const },
      ],
    };
    const preview = await transfer.preview(input);
    expect(preview.canImport).toBe(true);
    expect(service.importMcpToolPresetBatch).not.toHaveBeenCalled();
    await expect(
      transfer.import(
        {
          ...input,
          decisions: [{ index: 0, action: "CREATE", name: "Changed" }],
        },
        preview.token,
      ),
    ).rejects.toThrow("changed");
    service.mcpPresetStateHash.mockResolvedValue("state-2");
    await expect(transfer.import(input, preview.token)).rejects.toThrow(
      "changed",
    );
    expect(service.importMcpToolPresetBatch).not.toHaveBeenCalled();
  });

  test("exports lossless preset content without installation identity or credentials", async () => {
    const { transfer, service, server } = setup();
    service.mcpToolPresets.mockResolvedValue([
      {
        ...preset,
        id: "preset-local-id",
        toolNames: ["get_codebases"],
        tools: [
          { source: "BUILTIN", name: "get_codebases" },
          {
            source: "EXTERNAL",
            serverId: server.id,
            name: "search",
            serverName: "Example",
          },
        ],
        createdAt: "now",
        updatedAt: "now",
      },
    ]);
    const result = await transfer.exportPresets(["preset-local-id"]);
    const parsed = parseMcpPresetDocument(result.content);
    expect(parsed.presets[0]!.tools[1]).toEqual({
      source: "EXTERNAL",
      serverKey: "server-1",
      name: "search",
    });
    for (const secret of [
      server.id,
      "preset-local-id",
      server.url,
      "Authorization",
      "header-id",
      "createdAt",
    ])
      expect(result.content).not.toContain(secret);
  });

  test.each([
    { label: "ASCII", count: 100, toolCount: 300, toolPrefix: "tool" },
    {
      label: "Unicode",
      count: 50,
      toolCount: 200,
      toolPrefix: "工具".repeat(20),
    },
  ])(
    "rejects oversized exports and allows smaller selections: $label",
    async ({ count, toolCount, toolPrefix }) => {
      const { transfer, service, server } = setup();
      const presets: McpToolPresetView[] = Array.from(
        { length: count },
        (_, i) => ({
          ...preset,
          id: `preset-${i}`,
          name: `Preset ${i}`,
          toolNames: [],
          tools: Array.from({ length: toolCount }, (_, j) => ({
            source: "EXTERNAL",
            serverId: server.id,
            name: `${toolPrefix}_${j}`,
          })),
          createdAt: "now",
          updatedAt: "now",
        }),
      );
      service.mcpToolPresets.mockResolvedValue(presets);

      await expect(
        transfer
          .exportPresets(presets.map(({ id }) => id))
          .then(() => undefined),
      ).rejects.toThrow("Select fewer presets");

      const result = await transfer.exportPresets([presets[0]!.id]);
      expect(
        new TextEncoder().encode(result.content).length,
      ).toBeLessThanOrEqual(MAX_MCP_IMPORT_BYTES);
      expect(
        parseMcpPresetDocument(result.content).presets[0]!.tools,
      ).toHaveLength(toolCount);
    },
  );

  test("exports full schemas, availability, group filters, and examples drawn only from selected tools", async () => {
    const { transfer, service, catalog, server } = setup();
    catalog.push({
      id: `external:${server.id}`,
      name: "Example",
      source: "EXTERNAL",
      url: server.url,
      transport: "STREAMABLE_HTTP",
      error: null,
      children: [],
      tools: [
        {
          ...catalog[0]!.tools[0]!,
          name: "example_search",
          reference: {
            source: "EXTERNAL",
            name: "search",
            serverId: server.id,
          },
        },
      ],
    });
    const exported = await transfer.exportCatalog("JSON", "ALL", [
      `external:${server.id}`,
    ]);
    const value = JSON.parse(exported.content);
    expect(value.groups).toHaveLength(1);
    expect(value.groups[0].tools[0].inputSchema.type).toBe("object");
    expect(value.example.presets[0].tools).toEqual([
      { source: "EXTERNAL", name: "search", serverKey: "server-1" },
    ]);
    expect(() =>
      parseMcpPresetDocument(JSON.stringify(value.example)),
    ).not.toThrow();
    expect(exported.content).not.toContain(server.id);
    expect(exported.content).not.toContain(server.url);
    expect(service.catalog).toHaveBeenCalledWith({
      source: undefined,
      includeUnavailable: true,
    });
    const markdown = await transfer.exportCatalog("MARKDOWN", "ALL");
    expect(markdown.content).toContain("Importable preset schema");
    expect(markdown.content).toContain('"inputSchema"');
  });

  test("uses a shared discovery cache per preview and warns about provider configuration", async () => {
    const { transfer, service, catalog } = setup();
    catalog[0]!.tools[0]!.available = false;
    catalog[0]!.tools[0]!.availabilityReason = "Configure provider credentials";
    const preview = await transfer.preview({
      document: document([preset, { ...preset, name: "Second" }]),
    });
    expect(preview.canImport).toBe(true);
    expect(preview.entries[0]!.warnings[0]).toContain(
      "Configure provider credentials",
    );
    const calls = service.resolveMcpToolReferences.mock.calls;
    expect(calls[0]![1]).toBe(calls[1]![1]);
  });
});
