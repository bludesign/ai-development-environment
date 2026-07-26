import { afterEach, describe, expect, test, vi } from "vitest";

import { authorizeToolRequest } from "./tool-api-auth";

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
});
