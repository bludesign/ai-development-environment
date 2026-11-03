import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderCallbacks, ProviderStartInput } from "./provider.js";

import {
  CodexAdapter,
  codexAppServerArgs,
  codexCompletedFinalAnswer,
  codexRunConfig,
} from "./codex-adapter.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Codex app-server", () => {
  test("reports the native transcript and working directory when starting a run", async () => {
    const adapter = new CodexAdapter();
    const server = (
      adapter as unknown as {
        server: { request(method: string): Promise<unknown> };
      }
    ).server;
    vi.spyOn(server, "request").mockImplementation(async (method) =>
      method === "thread/start"
        ? {
            thread: {
              id: "thread-1",
              cwd: "/workspace",
              path: "/custom/codex/rollout.jsonl",
              cliVersion: "0.166.0",
            },
          }
        : { turn: { id: "turn-1" } },
    );
    const callbacks: ProviderCallbacks = {
      onNativeId: vi.fn(),
      onEvent: vi.fn(),
      onUsage: vi.fn(),
      onQuestion: vi.fn(),
    };
    await adapter.start(
      {
        run: {
          kind: "SESSION",
          model: "default",
          effort: null,
          webSearchEnabled: false,
          worktree: { folder: "/workspace" },
        },
        prompt: "Fix imports",
        attachments: [],
      } satisfies ProviderStartInput,
      callbacks,
    );
    expect(callbacks.onNativeId).toHaveBeenCalledWith("thread-1", "0.166.0", {
      nativeTranscriptPath: "/custom/codex/rollout.jsonl",
      workingDirectory: "/workspace",
    });
  });

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

  test("isolated generation explicitly disables inherited MCP servers, plugins and apps", () => {
    const config = codexRunConfig(
      { run: { webSearchEnabled: false } as never, textOnly: true },
      {
        mcp_servers: { external: { command: "example", enabled: true } },
        plugins: { "plugin@example": { enabled: true } },
        apps: { external: { enabled: true } },
      },
    );
    expect(config.mcp_servers).toEqual({ external: { enabled: false } });
    expect(config.plugins).toEqual({ "plugin@example": { enabled: false } });
    expect(config.apps).toEqual({
      _default: { enabled: false },
      external: { enabled: false },
    });
    expect(config.web_search).toBe("disabled");
    expect(config.features).toMatchObject({
      shell_tool: false,
      apply_patch_freeform: false,
      apps: false,
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

describe("Codex history discovery", () => {
  test("sends hydrated activity and transcript usage and refreshes active histories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-discover-"));
    try {
      const path = join(directory, "rollout.jsonl");
      await writeFile(
        path,
        [
          {
            type: "turn_context",
            payload: { model: "model-a", effort: "high", turn_id: "turn-1" },
          },
          {
            type: "token_usage_record",
            payload: {
              response_id: "response-1",
              turn_id: "turn-1",
              usage: {
                input_tokens: 100,
                cached_input_tokens: 80,
                output_tokens: 10,
              },
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      );
      const thread = {
        id: "thread-1",
        path,
        createdAt: 100,
        updatedAt: 200,
        status: { type: "idle" },
      };
      const item = {
        id: "item-1",
        type: "agentMessage",
        phase: "final_answer",
        text: "Done",
      };
      const adapter = new CodexAdapter();
      const server = (
        adapter as unknown as {
          server: {
            request(
              method: string,
              params: Record<string, unknown>,
            ): Promise<unknown>;
          };
        }
      ).server;
      const request = vi
        .spyOn(server, "request")
        .mockImplementation(async (method, params) => {
          if (method === "thread/list")
            return { data: params.archived ? [] : [thread], nextCursor: null };
          return {
            thread: { ...thread, turns: [{ id: "turn-1", items: [item] }] },
          };
        });
      const worktrees = [
        { id: "worktree-1", folder: directory, branch: "main" },
      ];
      const [imported] = await adapter.discover(worktrees);
      expect(request).toHaveBeenCalledWith(
        "thread/list",
        expect.objectContaining({
          sourceKinds: ["cli", "vscode", "exec", "appServer"],
        }),
      );
      expect(imported).toMatchObject({
        sessionInfo: {
          nativeTranscriptPath: path,
          workingDirectory: directory,
        },
        model: "model-a",
        effort: "high",
        finalOutput: "Done",
        usage: [{ model: "model-a", inputTokens: 20, cacheReadTokens: 80 }],
        events: [{ id: "turn-1:item-1", raw: { method: "item/completed" } }],
      });
      await adapter.discover(worktrees);
      expect(
        request.mock.calls.filter(([method]) => method === "thread/read"),
      ).toHaveLength(1);
      thread.status.type = "active";
      item.text = "Still running";
      expect((await adapter.discover(worktrees))[0]?.finalOutput).toBe(
        "Still running",
      );
      expect(
        request.mock.calls.filter(([method]) => method === "thread/read"),
      ).toHaveLength(2);
      thread.status.type = "idle";
      item.text = "Finished";
      expect((await adapter.discover(worktrees))[0]?.finalOutput).toBe(
        "Finished",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retries hydration failures without inventing an empty history snapshot", async () => {
    const adapter = new CodexAdapter();
    const server = (
      adapter as unknown as {
        server: {
          request(
            method: string,
            params: Record<string, unknown>,
          ): Promise<unknown>;
        };
      }
    ).server;
    let reads = 0;
    vi.spyOn(server, "request").mockImplementation(async (method, params) => {
      if (method === "thread/list")
        return {
          data: params.archived
            ? []
            : [
                {
                  id: "missing-thread",
                  path: "/nonexistent/codex-rollout",
                  updatedAt: 200,
                },
              ],
          nextCursor: null,
        };
      reads += 1;
      if (reads === 1) throw new Error("History unavailable");
      return { thread: { turns: [] } };
    });
    const worktrees = [{ id: "worktree-1", folder: "/test", branch: null }];
    expect((await adapter.discover(worktrees))[0]?.events).toBeUndefined();
    expect((await adapter.discover(worktrees))[0]?.events).toEqual([]);
    expect(reads).toBe(2);
  });

  test("uses persisted failure status for unloaded threads and runtime system errors", async () => {
    const adapter = new CodexAdapter();
    const server = (
      adapter as unknown as {
        server: {
          request(
            method: string,
            params: Record<string, unknown>,
          ): Promise<unknown>;
        };
      }
    ).server;
    const thread = {
      id: "thread-1",
      path: "/nonexistent/codex-rollout",
      status: { type: "notLoaded" },
      updatedAt: 200,
    };
    vi.spyOn(server, "request").mockImplementation(async (method, params) =>
      method === "thread/list"
        ? { data: params.archived ? [] : [thread] }
        : {
            thread: {
              ...thread,
              turns: [{ id: "turn", status: "failed", items: [] }],
            },
          },
    );
    const worktrees = [{ id: "worktree-1", folder: "/test", branch: null }];
    expect((await adapter.discover(worktrees))[0]?.status).toBe("FAILED");
    thread.status.type = "systemError";
    expect((await adapter.discover(worktrees))[0]?.status).toBe("FAILED");
  });
});

describe("Codex transcript location discovery", () => {
  test("refreshes an archived path even when transcript hydration stays cached", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-moving-transcript-"));
    vi.stubEnv("CODEX_HOME", directory);
    try {
      const sessions = join(directory, "sessions");
      const archive = join(directory, "archived_sessions");
      await mkdir(sessions);
      await mkdir(archive);
      const filename = "rollout-2026-thread-moving.jsonl";
      const originalPath = join(sessions, filename);
      const archivedPath = join(archive, filename);
      await writeFile(
        originalPath,
        [
          {
            type: "turn_context",
            payload: { model: "model-a", turn_id: "turn" },
          },
          {
            type: "token_usage_record",
            payload: {
              turn_id: "turn",
              response_id: "response",
              usage: { input_tokens: 10 },
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      );
      let archived = false;
      const thread = { id: "thread-moving", updatedAt: 200 };
      const adapter = new CodexAdapter();
      const server = (
        adapter as unknown as {
          server: {
            request(
              method: string,
              params: Record<string, unknown>,
            ): Promise<unknown>;
          };
        }
      ).server;
      const request = vi
        .spyOn(server, "request")
        .mockImplementation(async (method, params) =>
          method === "thread/list"
            ? { data: params.archived === archived ? [thread] : [] }
            : { thread: { ...thread, turns: [] } },
        );
      const worktrees = [{ id: "wt", folder: "/workspace", branch: null }];
      expect(
        (await adapter.discover(worktrees))[0]?.sessionInfo
          ?.nativeTranscriptPath,
      ).toBe(originalPath);
      await rename(originalPath, archivedPath);
      archived = true;
      expect(
        (await adapter.discover(worktrees))[0]?.sessionInfo
          ?.nativeTranscriptPath,
      ).toBe(archivedPath);
      expect(
        request.mock.calls.filter(([method]) => method === "thread/read"),
      ).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("locates archived transcripts under a custom Codex home", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-custom-home-"));
    vi.stubEnv("CODEX_HOME", directory);
    try {
      const archived = join(directory, "archived_sessions");
      await mkdir(archived);
      const path = join(archived, "rollout-2026-thread-archived.jsonl");
      await writeFile(path, "");
      const adapter = new CodexAdapter();
      const server = (
        adapter as unknown as {
          server: {
            request(
              method: string,
              params: Record<string, unknown>,
            ): Promise<unknown>;
          };
        }
      ).server;
      vi.spyOn(server, "request").mockImplementation(async (method, params) =>
        method === "thread/list"
          ? {
              data: params.archived ? [{ id: "thread-archived" }] : [],
            }
          : { thread: { id: "thread-archived", turns: [] } },
      );
      const [run] = await adapter.discover([
        { id: "wt", folder: "/workspace", branch: null },
      ]);
      expect(run?.sessionInfo).toEqual({
        nativeTranscriptPath: path,
        workingDirectory: "/workspace",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
