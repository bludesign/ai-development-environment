import { describe, expect, test } from "vitest";

import {
  codexAppServerArgs,
  codexCompletedFinalAnswer,
  codexRunConfig,
} from "./codex-adapter.js";

describe("Codex app-server", () => {
  test("merges the run-scoped AIDE MCP server into thread configuration", () => {
    expect(
      codexRunConfig({
        run: { webSearchEnabled: true } as never,
        mcpServer: {
          name: "ai-development-environment",
          url: "https://control.test/api/mcp?run=run-1",
          headers: { authorization: "Bearer agent" },
        },
      }),
    ).toEqual({
      web_search: "live",
      mcp_servers: {
        "ai-development-environment": {
          url: "https://control.test/api/mcp?run=run-1",
          http_headers: { authorization: "Bearer agent" },
        },
      },
    });
  });

  test("uses the bundled catalog instead of refreshing through model proxies", () => {
    expect(codexAppServerArgs("/tmp/models.json")).toEqual([
      "app-server",
      "-c",
      'model_catalog_json="/tmp/models.json"',
      "--listen",
      "stdio://",
    ]);
  });

  test("extracts only the completed final answer", () => {
    expect(
      codexCompletedFinalAnswer({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            text: "Still working.",
            phase: "commentary",
          },
        },
      }),
    ).toBeUndefined();
    expect(
      codexCompletedFinalAnswer({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            text: "Fixed the issue.",
            phase: "final_answer",
          },
        },
      }),
    ).toBe("Fixed the issue.");
  });
});
