import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, test, vi } from "vitest";
import * as z from "zod/v4";
import { BuiltInToolRegistry, defineTool } from "./builtin-tools";
import { createBuiltInMcpServer } from "./codebases-mcp";
import { createScopedMcpServer } from "./scoped-mcp";
import type { McpToolSnapshot } from "./types";
import { compileMcpJsonSchema } from "./mcp-json-schema";

describe.each(["auto", "legacy"] as const)(
  "MCP HTTP %s negotiation",
  (mode) => {
    test("discovers, lists complete schemas and calls structured tools with isolated request factories", async () => {
      const calls: string[] = [];
      const registry = new BuiltInToolRegistry([
        {
          id: "test",
          name: "Test",
          children: [],
          tools: [
            defineTool({
              name: "get_codebases",
              title: "Codebases",
              description: "Test complete Zod schema registration",
              inputSchema: z.object({
                limit: z.number().int().min(1).default(10),
              }),
              outputSchema: z.object({ caller: z.string(), limit: z.number() }),
              handler: async () => ({ caller: "unused", limit: 10 }),
            }),
          ],
        },
      ]);
      const handler = createMcpHandler(
        (ctx) =>
          createBuiltInMcpServer(registry, async (_name, input) => {
            const caller = ctx.requestInfo!.headers.get("x-test-user")!;
            calls.push(caller);
            const data = { caller, limit: (input as { limit: number }).limit };
            return {
              content: [{ type: "text", text: JSON.stringify(data) }],
              structuredContent: data,
            };
          }),
        { legacy: "stateless" },
      );
      const clients = ["alice", "bob"].map((caller) => {
        const client = new Client(
          { name: caller, version: "1" },
          { versionNegotiation: { mode } },
        );
        const transport = new StreamableHTTPClientTransport(
          new URL("https://control.example/api/mcp"),
          {
            fetch: (url, init) =>
              handler.fetch(
                new Request(url, {
                  ...init,
                  headers: new Headers({
                    ...Object.fromEntries(new Headers(init?.headers)),
                    "x-test-user": caller,
                  }),
                }),
              ),
          },
        );
        return { client, transport };
      });
      try {
        await Promise.all(
          clients.map(({ client, transport }) => client.connect(transport)),
        );
        const catalog = await clients[0].client.listTools();
        expect(catalog.tools).toHaveLength(1);
        expect(
          compileMcpJsonSchema(catalog.tools[0].inputSchema)({}).valid,
        ).toBe(true);
        expect(
          compileMcpJsonSchema(catalog.tools[0].inputSchema)({ limit: 0 })
            .valid,
        ).toBe(false);
        expect(catalog.tools[0]._meta).toMatchObject({
          "aide/requiredScopes": ["mcp:read"],
        });
        const results = await Promise.all(
          clients.map(({ client }) =>
            client.callTool({ name: "get_codebases", arguments: {} }),
          ),
        );
        expect(results.map((result) => result.structuredContent)).toEqual([
          { caller: "alice", limit: 10 },
          { caller: "bob", limit: 10 },
        ]);
        expect(calls.sort()).toEqual(["alice", "bob"]);
      } finally {
        await Promise.all(clients.map(({ client }) => client.close()));
        await handler.close();
      }
    });
    test("preserves frozen external schemas and rich results", async () => {
      const inputSchema = {
        type: "object",
        properties: { query: { type: "string", minLength: 2 } },
        required: ["query"],
        additionalProperties: false,
      };
      const outputSchema = {
        type: "object",
        properties: { found: { type: "boolean" } },
        required: ["found"],
      };
      const snapshot: McpToolSnapshot = {
        schemaVersion: 1,
        tools: [
          {
            name: "external_search",
            title: "Search",
            description: "Remote",
            inputSchema,
            outputSchema,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: true,
              idempotentHint: true,
            },
            reference: {
              source: "EXTERNAL",
              name: "search",
              serverId: "server",
            },
          },
        ],
      };
      const frozen = JSON.stringify(snapshot);
      const handler = createMcpHandler(
        () =>
          createScopedMcpServer(snapshot, async () => ({
            content: [
              { type: "text", text: "found" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
            structuredContent: { found: true },
          })),
        { legacy: "stateless" },
      );
      const client = new Client(
        { name: "test", version: "1" },
        { versionNegotiation: { mode } },
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL("https://control.example/api/mcp?preset=one"),
            { fetch: (url, init) => handler.fetch(new Request(url, init)) },
          ),
        );
        const catalog = await client.listTools();
        expect(catalog.tools[0].inputSchema).toEqual(inputSchema);
        expect(catalog.tools[0].outputSchema).toEqual(outputSchema);
        expect(catalog.tools[0]._meta?.["aide/requiredScopes"]).toEqual([
          "mcp:read",
          "mcp:write",
          "mcp:destructive",
        ]);
        const result = await client.callTool({
          name: "external_search",
          arguments: { query: "find" },
        });
        expect(result.structuredContent).toEqual({ found: true });
        expect(result.content).toContainEqual({
          type: "image",
          data: "aW1hZ2U=",
          mimeType: "image/png",
        });
        expect(JSON.stringify(snapshot)).toBe(frozen);
      } finally {
        await client.close();
        await handler.close();
      }
    });
    test("projects non-object output schemas and structured results consistently without changing snapshots", async () => {
      const snapshot: McpToolSnapshot = {
        schemaVersion: 1,
        tools: [
          {
            name: "array_result",
            title: null,
            description: null,
            inputSchema: { type: "object" },
            outputSchema: { type: "array", items: { type: "string" } },
            annotations: null,
            reference: {
              source: "EXTERNAL",
              name: "array_result",
              serverId: "s",
            },
          },
        ],
      };
      const original = JSON.stringify(snapshot);
      const handler = createMcpHandler(
        () =>
          createScopedMcpServer(snapshot, async () => ({
            content: [],
            structuredContent: ["one", "two"],
          })),
        { legacy: "stateless" },
      );
      const client = new Client(
        { name: "array-test", version: "1" },
        { versionNegotiation: { mode } },
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL("https://control.example/api/mcp"),
            { fetch: (url, init) => handler.fetch(new Request(url, init)) },
          ),
        );
        const catalog = await client.listTools();
        const result = await client.callTool({
          name: "array_result",
          arguments: {},
        });
        expect(
          compileMcpJsonSchema(catalog.tools[0].outputSchema!)(
            result.structuredContent,
          ).valid,
        ).toBe(true);
        expect(result.structuredContent).toEqual(
          mode === "auto" ? ["one", "two"] : { result: ["one", "two"] },
        );
        expect(JSON.stringify(snapshot)).toBe(original);
      } finally {
        await client.close();
        await handler.close();
      }
    });
    test("forwards HTTP cancellation to the scoped invocation", async () => {
      const invoked = vi.fn();
      const snapshot: McpToolSnapshot = {
        schemaVersion: 1,
        tools: [
          {
            name: "slow",
            title: null,
            description: null,
            inputSchema: { type: "object" },
            outputSchema: null,
            annotations: null,
            reference: { source: "EXTERNAL", name: "slow", serverId: "s" },
          },
        ],
      };
      const handler = createMcpHandler(
        (ctx) =>
          createScopedMcpServer(snapshot, async (_tool, _args, sdkSignal) => {
            const signal = AbortSignal.any([
              sdkSignal,
              ctx.requestInfo!.signal,
            ]);
            invoked(signal);
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
            return { content: [] };
          }),
        { legacy: "stateless" },
      );
      const controller = new AbortController();
      const client = new Client(
        { name: "cancel-test", version: "1" },
        { versionNegotiation: { mode } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL("https://control.example/api/mcp"),
          {
            fetch: (url, init) =>
              handler.fetch(
                new Request(url, {
                  ...init,
                  signal: AbortSignal.any([
                    ...(init?.signal ? [init.signal] : []),
                    controller.signal,
                  ]),
                }),
              ),
          },
        ),
      );
      const pending = client.callTool(
        { name: "slow", arguments: {} },
        { signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(invoked).toHaveBeenCalled());
      controller.abort();
      await rejected;
      await vi.waitFor(() =>
        expect(invoked.mock.calls[0][0].aborted).toBe(true),
      );
      await client.close();
      await handler.close();
    });
  },
);
