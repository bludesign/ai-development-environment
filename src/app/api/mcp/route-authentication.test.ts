import { beforeEach, describe, expect, test, vi } from "vitest";
import * as z from "zod/v4";

const mocks = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  getSession: vi.fn(),
  authorizeMcpOAuthRequest: vi.fn(),
  callBuiltInTool: vi.fn(),
  callSnapshotTool: vi.fn(),
  mcpPresetSnapshot: vi.fn(),
}));

vi.mock("@/services/auth/auth", () => ({
  getAuth: async () => ({
    api: { verifyApiKey: mocks.verifyApiKey, getSession: mocks.getSession },
  }),
}));

vi.mock("@/services/auth/mcp-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/auth/mcp-oauth")>()),
  authorizeMcpOAuthRequest: mocks.authorizeMcpOAuthRequest,
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    toolsService: { ...mocks, builtInTools: registry },
  }),
}));

import {
  BuiltInToolRegistry,
  defineTool,
} from "@/services/tools/builtin-tools";
import { POST } from "./route";

const registry = new BuiltInToolRegistry([
  {
    id: "test",
    name: "Test",
    children: [],
    tools: [
      defineTool({
        name: "get_codebases",
        title: "Codebases",
        description: "List codebases",
        inputSchema: z.object({}),
        outputSchema: z.object({ codebases: z.array(z.string()) }),
        handler: () => ({ codebases: [] }),
      }),
    ],
  },
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyApiKey.mockImplementation(
    async ({ body }: { body: { key: string } }) =>
      body.key === "aide_valid"
        ? {
            valid: true,
            key: { id: "key-1", referenceId: "user-1", name: "Tunnel" },
          }
        : { valid: false, key: null },
  );
  mocks.authorizeMcpOAuthRequest.mockResolvedValue({
    principal: {
      kind: "mcpOAuth",
      userId: "user-1",
      clientId: "client-1",
      authorizationId: "authorization-1",
      scopes: ["mcp:read"],
    },
  });
  const result = {
    content: [{ type: "text", text: '{"codebases":[]}' }],
    structuredContent: { codebases: [] },
  };
  mocks.callBuiltInTool.mockResolvedValue(result);
  mocks.callSnapshotTool.mockResolvedValue(result);
  mocks.mcpPresetSnapshot.mockResolvedValue({
    schemaVersion: 1,
    tools: [
      {
        name: "get_codebases",
        title: null,
        description: null,
        inputSchema: { type: "object" },
        outputSchema: null,
        annotations: null,
        reference: { source: "BUILTIN", name: "get_codebases" },
      },
      {
        name: "aide_ext_0123456789abcdef_search",
        title: null,
        description: null,
        inputSchema: { type: "object" },
        outputSchema: null,
        annotations: { readOnlyHint: true },
        reference: { source: "EXTERNAL", name: "search", serverId: "server-1" },
      },
    ],
  });
});

function request(
  path: string,
  headers: HeadersInit,
  method = "tools/list",
  name?: string,
  protocolVersion = "2025-11-25",
) {
  return new Request(`https://control.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...(protocolVersion === "2026-07-28"
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {
                  name: "authentication-test",
                  version: "1",
                },
              },
            }
          : {}),
        ...(name ? { name, arguments: {} } : {}),
      },
    }),
  });
}

describe.each(["/api/mcp", "/api/mcp?preset=preset-1"])(
  "%s authentication metadata",
  (path) => {
    test.each(
      ["2025-11-25", "2026-07-28"].flatMap((protocolVersion) =>
        ["apiKey", "oauth"].map((authentication) => ({
          authentication,
          protocolVersion,
        })),
      ),
    )(
      "publishes matching auth declarations for $authentication with $protocolVersion",
      async ({ authentication, protocolVersion }) => {
        const headers: HeadersInit =
          authentication === "apiKey"
            ? { "x-api-key": "aide_valid" }
            : { authorization: "Bearer header.payload.signature" };
        const response = await POST(
          request(path, headers, "tools/list", undefined, protocolVersion),
        );
        const payload = await response.text();
        expect(response.status, payload).toBe(200);
        const body = JSON.parse(
          response.headers.get("content-type")?.includes("text/event-stream")
            ? payload
                .split("\n")
                .find((line) => line.startsWith("data: "))!
                .slice(6)
            : payload,
        );
        expect(body.result.tools).toHaveLength(path.includes("preset") ? 2 : 1);
        for (const tool of body.result.tools) {
          const scopes =
            tool.name === "get_codebases"
              ? ["mcp:read"]
              : ["mcp:read", "mcp:write", "mcp:destructive"];
          const securitySchemes =
            authentication === "apiKey"
              ? [{ type: "noauth" }]
              : [{ type: "oauth2", scopes }];
          expect(tool.securitySchemes).toEqual(securitySchemes);
          expect(tool._meta.securitySchemes).toEqual(securitySchemes);
          expect(tool._meta["aide/requiredScopes"]).toEqual(scopes);
        }
        if (authentication === "apiKey") {
          expect(mocks.verifyApiKey).toHaveBeenCalledWith({
            body: { key: "aide_valid" },
          });
          expect(mocks.authorizeMcpOAuthRequest).not.toHaveBeenCalled();
        } else {
          expect(mocks.authorizeMcpOAuthRequest).toHaveBeenCalledOnce();
          expect(mocks.verifyApiKey).not.toHaveBeenCalled();
        }
      },
    );

    test("calls a tool with the validated API-key context", async () => {
      const response = await POST(
        request(
          path,
          { "x-api-key": "aide_valid" },
          "tools/call",
          "get_codebases",
        ),
      );
      expect(response.status).toBe(200);
      await response.text();
      const invoke = path.includes("preset")
        ? mocks.callSnapshotTool
        : mocks.callBuiltInTool;
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0][2]).toMatchObject({
        authentication: "apiKey",
      });
    });

    test.each([undefined, "aide_invalid"])(
      "rejects missing or invalid API keys before discovery or execution",
      async (key) => {
        const headers: HeadersInit = key ? { "x-api-key": key } : {};
        for (const method of ["initialize", "tools/list", "tools/call"]) {
          const response = await POST(
            request(path, headers, method, "get_codebases"),
          );
          expect(response.status).toBe(401);
        }
        expect(mocks.mcpPresetSnapshot).not.toHaveBeenCalled();
        expect(mocks.callBuiltInTool).not.toHaveBeenCalled();
        expect(mocks.callSnapshotTool).not.toHaveBeenCalled();
      },
    );
  },
);

test("retains OAuth scope checks for tools in an API-key-compatible preset", async () => {
  const response = await POST(
    request(
      "/api/mcp?preset=preset-1",
      { authorization: "Bearer header.payload.signature" },
      "tools/call",
      "aide_ext_0123456789abcdef_search",
    ),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain("mcp:destructive");
  expect(mocks.callSnapshotTool).not.toHaveBeenCalled();
});
