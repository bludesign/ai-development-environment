import { afterEach, describe, expect, test, vi } from "vitest";

import {
  authorizeMcpPresetRequest,
  authorizeRunMcpRequest,
  authorizeToolRequest,
} from "./tool-api-auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool API authorization", () => {
  test("requires bearer authentication even for same-origin Tools page calls", () => {
    vi.stubEnv("TOOLS_API_TOKEN", "deployment-secret");
    const denied = authorizeToolRequest(
      new Request("https://control.example/api/tools/call", {
        method: "POST",
        headers: {
          origin: "https://control.example",
          "sec-fetch-site": "same-origin",
          "x-request-id": "request-1",
        },
      }),
      "TOOLS_PAGE",
    );
    expect("response" in denied && denied.response.status).toBe(401);

    const allowed = authorizeToolRequest(
      new Request("https://control.example/api/tools/call", {
        method: "POST",
        headers: {
          authorization: "Bearer deployment-secret",
          "x-request-id": "request-1",
        },
      }),
      "TOOLS_PAGE",
    );
    expect(allowed).toMatchObject({
      context: {
        source: "TOOLS_PAGE",
        correlationId: "request-1",
        caller: expect.stringMatching(/^bearer:/),
      },
    });
  });

  test("allows unauthenticated calls when the deployment token is not configured", () => {
    vi.stubEnv("TOOLS_API_TOKEN", "");
    const result = authorizeToolRequest(
      new Request("https://control.example/api/mcp", {
        headers: { "x-request-id": "request-without-auth" },
      }),
      "MCP",
    );
    expect(result).toMatchObject({
      context: {
        source: "MCP",
        correlationId: "request-without-auth",
        caller: "anonymous@unknown",
      },
    });
  });

  test("requires and fingerprints a valid MCP bearer token", () => {
    vi.stubEnv("TOOLS_API_TOKEN", "deployment-secret");
    const denied = authorizeToolRequest(
      new Request("https://control.example/api/mcp", {
        headers: { authorization: "Bearer wrong" },
      }),
      "MCP",
    );
    expect("response" in denied && denied.response.status).toBe(401);

    const allowed = authorizeToolRequest(
      new Request("https://control.example/api/mcp", {
        headers: {
          authorization: "Bearer deployment-secret",
          "x-request-id": "request-2",
        },
      }),
      "MCP",
    );
    expect(allowed).toMatchObject({
      context: {
        source: "MCP",
        correlationId: "request-2",
        caller: expect.stringMatching(/^bearer:[a-f0-9]{12}@/),
      },
    });
    expect(JSON.stringify(allowed)).not.toContain("deployment-secret");
  });

  test("always requires a configured deployment token for preset URLs", () => {
    vi.stubEnv("TOOLS_API_TOKEN", "");
    expect(
      "response" in
        authorizeMcpPresetRequest(
          new Request("https://control.example/api/mcp?preset=preset-1"),
        ),
    ).toBe(true);
    const missing = authorizeMcpPresetRequest(
      new Request("https://control.example/api/mcp?preset=preset-1"),
    );
    expect("response" in missing && missing.response.status).toBe(503);

    vi.stubEnv("TOOLS_API_TOKEN", "deployment-secret");
    const allowed = authorizeMcpPresetRequest(
      new Request("https://control.example/api/mcp?preset=preset-1", {
        headers: { authorization: "Bearer deployment-secret" },
      }),
    );
    expect(allowed).toMatchObject({ context: { source: "MCP" } });
  });

  test("accepts only enrolled agent credentials for run-scoped URLs", async () => {
    const authenticate = vi.fn(async (credential: string | null) =>
      credential === "agent-secret" ? "agent-1" : null,
    );
    const denied = await authorizeRunMcpRequest(
      new Request("https://control.example/api/mcp?run=run-1", {
        headers: { authorization: "Bearer deployment-secret" },
      }),
      { authenticate } as never,
    );
    expect("response" in denied && denied.response.status).toBe(401);

    const allowed = await authorizeRunMcpRequest(
      new Request("https://control.example/api/mcp?run=run-1", {
        headers: { authorization: "Bearer agent-secret" },
      }),
      { authenticate } as never,
    );
    expect(allowed).toMatchObject({
      agentId: "agent-1",
      context: { caller: "agent:agent-1@unknown", source: "MCP" },
    });
  });
});
