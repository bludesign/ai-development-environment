import { describe, expect, test } from "vitest";

import {
  codexAppServerArgs,
  codexRunConfig,
  codexVersionFromUserAgent,
  supportedCodexVersion,
} from "./codex-adapter.js";

describe("Codex app-server protocol guard", () => {
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

  test("accepts the generated protocol fixture version", () => {
    const version = codexVersionFromUserAgent(
      "Codex Desktop/0.145.0 (Mac OS 26.5; arm64) dumb (control-agent; 0.1.0)",
    );
    expect(version).toBe("0.145.0");
    expect(supportedCodexVersion(version)).toBe(true);
    expect(supportedCodexVersion("0.144.6")).toBe(true);
    expect(supportedCodexVersion("0.143.9")).toBe(false);
  });

  test.each(["", "Codex Desktop/dev", "Codex Desktop 0.145.0"])(
    "rejects an unparseable user agent: %s",
    (value) => expect(codexVersionFromUserAgent(value)).toBeNull(),
  );
});
