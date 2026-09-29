import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { CodebaseToolsService } from "@/services/codebases";
import type { ActionCenterService } from "@/services/action-center";

import {
  createBuiltInToolRegistry,
  READ_ONLY_ANNOTATIONS,
} from "./builtin-tools";
import { createScopedMcpServer } from "./scoped-mcp";
import { compileMcpJsonSchema } from "./mcp-json-schema";
import { ToolsService } from "./tools.service";
import type { McpToolSnapshotEntry } from "./types";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function clientFor(
  tools: McpToolSnapshotEntry[],
  invoke: Parameters<typeof createScopedMcpServer>[1],
) {
  const server = createScopedMcpServer({ schemaVersion: 1, tools }, invoke);
  const client = new Client({ name: "scoped-mcp-review", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function externalTool(): McpToolSnapshotEntry {
  return {
    name: "aide_ext_0123456789abcdef_search",
    title: "Search",
    description: "Search external documents",
    inputSchema: {
      type: "object",
      $defs: { query: { type: "string", minLength: 1 } },
      properties: {
        query: { $ref: "#/$defs/query" },
        documentId: { type: "string" },
      },
      oneOf: [{ required: ["query"] }, { required: ["documentId"] }],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 0 } },
      required: ["count"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    reference: {
      source: "EXTERNAL",
      serverId: "private-server-id",
      serverName: "Private server",
      name: "search",
    },
    endpointHash: "private-endpoint-fingerprint",
  };
}

describe("scoped MCP protocol compatibility", () => {
  test("keeps defaulted built-in arguments optional in snapshots and catalog exports", async () => {
    const page = {
      items: [],
      nextCursor: null,
      totalCount: 0,
      needsAttentionCount: 0,
      activeCount: 0,
    };
    const list = vi.fn().mockResolvedValue(page);
    const service = new ToolsService(
      {} as CodebaseToolsService,
      undefined,
      { actionCenter: { list } as unknown as ActionCenterService },
      { isConfigured: vi.fn().mockResolvedValue(false) } as never,
    );
    const snapshot = await service.resolveMcpToolReferences([
      { source: "BUILTIN", name: "get_action_center" },
    ]);
    const client = await clientFor(snapshot.tools, (entry, args) =>
      service.builtInTools.callByName(entry.reference.name, args),
    );
    const listed = await client.listTools();
    const validate = compileMcpJsonSchema(listed.tools[0]!.inputSchema);
    expect(validate({}).valid).toBe(true);
    expect(validate({ first: "invalid" }).valid).toBe(false);
    await expect(
      client.callTool({ name: "get_action_center", arguments: {} }),
    ).resolves.toMatchObject({ structuredContent: { page } });
    expect(list).toHaveBeenCalledWith({ first: 50 });

    const exported = await service.presetTransfers.exportCatalog(
      "JSON",
      "BUILTIN",
      ["builtin:action-center"],
    );
    const catalog = JSON.parse(exported.content);
    expect(
      compileMcpJsonSchema(catalog.groups[0].tools[0].inputSchema)({}).valid,
    ).toBe(true);
  });

  test("lists the real get_codebase union input through the SDK object-schema contract", async () => {
    const registry = createBuiltInToolRegistry({
      codebaseTools: {} as CodebaseToolsService,
    });
    const tool = registry
      .catalog()[0]!
      .tools.find(({ name }) => name === "get_codebase")!;
    expect(tool.inputSchema.anyOf).toBeDefined();
    const client = await clientFor(
      [{ ...tool, reference: { source: "BUILTIN", name: tool.name } }],
      vi.fn(),
    );

    const result = await client.listTools();

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.inputSchema).toEqual({
      type: "object",
      ...tool.inputSchema,
    });
  });

  test("preserves remote JSON Schema and annotations without exposing internal routing metadata", async () => {
    const tool = externalTool();
    const client = await clientFor([tool], vi.fn());

    const result = await client.listTools();

    expect(result.tools).toEqual([
      {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(tool.reference.serverId);
    expect(JSON.stringify(result)).not.toContain(tool.endpointHash);
  });

  test("forwards rich MCP results and private metadata intact", async () => {
    const tool = externalTool();
    const result: CallToolResult = {
      content: [
        {
          type: "text",
          text: "Found a document",
          annotations: { audience: ["assistant"] },
        },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
        {
          type: "resource",
          resource: {
            uri: "file:///result.md",
            mimeType: "text/markdown",
            text: "# Result",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///result.bin",
            mimeType: "application/octet-stream",
            blob: "YmluYXJ5",
          },
        },
        {
          type: "resource_link",
          uri: "https://example.test/result",
          name: "Result",
          mimeType: "text/plain",
        },
      ],
      structuredContent: { count: 1 },
      _meta: { trace: "upstream-trace", "vendor/context": { retained: true } },
    };
    const invoke = vi.fn().mockResolvedValue(result);
    const client = await clientFor([tool], invoke);
    await client.listTools();

    await expect(
      client.callTool({ name: tool.name, arguments: { query: "example" } }),
    ).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith(
      tool,
      { query: "example" },
      expect.any(AbortSignal),
    );
  });

  test("keeps upstream tool errors intact even without structured output", async () => {
    const tool = externalTool();
    const result: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "Upstream rejected the query" }],
      _meta: { trace: "failed-call" },
    };
    const client = await clientFor([tool], vi.fn().mockResolvedValue(result));
    await client.listTools();

    await expect(
      client.callTool({ name: tool.name, arguments: { query: "example" } }),
    ).resolves.toEqual(result);
  });

  test("rejects raw, display-prefixed and unselected names before dispatch", async () => {
    const tool = externalTool();
    const invoke = vi.fn();
    const client = await clientFor([tool], invoke);

    for (const name of [
      "search",
      "custom_search",
      "get_codebases",
      "aide_ext_ffffffffffffffff_search",
    ]) {
      await expect(
        client.callTool({ name, arguments: {} }),
      ).resolves.toMatchObject({
        isError: true,
        content: [
          { type: "text", text: "Tool is not included in this MCP scope" },
        ],
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  test("rejects task execution before dispatch", async () => {
    const tool = externalTool();
    const invoke = vi.fn();
    const client = await clientFor([tool], invoke);

    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: tool.name,
            arguments: { query: "example" },
            task: { ttl: 1000 },
          },
        },
        CallToolResultSchema,
      ),
    ).rejects.toThrow("Server does not support task creation");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("forwards SDK request cancellation to the active invocation", async () => {
    const tool = externalTool();
    const invoke = vi.fn(
      (_entry, _args, signal: AbortSignal) =>
        new Promise<CallToolResult>((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                isError: true,
                content: [{ type: "text", text: "Cancelled" }],
              }),
            { once: true },
          );
        }),
    );
    const client = await clientFor([tool], invoke);
    const controller = new AbortController();
    const call = client.callTool(
      { name: tool.name, arguments: { query: "example" } },
      undefined,
      { signal: controller.signal },
    );
    const rejectedCall = expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

    controller.abort();

    await rejectedCall;
    await vi.waitFor(() => expect(invoke.mock.calls[0]![2].aborted).toBe(true));
  });
});
