import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProviderCallbacks, ProviderStartInput } from "./provider.js";

const sdk = vi.hoisted(() => ({
  executionEnv: {} as Record<string, string>,
  gatedSpawn: vi.fn(),
  listSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  listSubagents: vi.fn(),
  getSubagentMessages: vi.fn(),
  query: vi.fn(),
  deleteSession: vi.fn(),
}));
const files = vi.hoisted(() => ({
  findClaudeSessionFile: vi.fn(),
  readClaudeTranscript: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("../execution-recovery.js", () => ({
  executionEnvironment: () => sdk.executionEnv,
  spawnExecutionProcess: sdk.gatedSpawn,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);
vi.mock("../handlers/runs.js", () => ({
  findClaudeSessionFile: files.findClaudeSessionFile,
}));
vi.mock("./claude-import.js", async (original) => ({
  ...(await original<typeof import("./claude-import.js")>()),
  readClaudeTranscript: files.readClaudeTranscript,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: files.stat,
}));

import { ClaudeAdapter } from "./claude-adapter.js";

const worktrees = [{ id: "worktree-1", folder: "/workspace", branch: "main" }];
const session = {
  sessionId: "session-1",
  summary: "Generated title",
  firstPrompt: "Prompt preview",
  lastModified: 2_000,
  createdAt: 1_000,
  fileSize: 1_000,
};
const reply = {
  type: "assistant",
  uuid: "assistant-1",
  message: {
    id: "response-1",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "Done" }],
    usage: { input_tokens: 10, output_tokens: 20 },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  sdk.executionEnv = {};
  sdk.listSessions.mockResolvedValue([{ ...session }]);
  sdk.getSessionMessages.mockResolvedValue([reply]);
  sdk.listSubagents.mockResolvedValue([]);
  sdk.getSubagentMessages.mockResolvedValue([]);
  files.findClaudeSessionFile.mockResolvedValue(null);
  files.stat.mockRejectedValue(new Error("No file fingerprint"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claude session info", () => {
  test("forwards child tools and text without completing or renaming the root session", async () => {
    const childTool = {
      type: "assistant",
      uuid: "child-tool",
      session_id: "child-session",
      agent_id: "agent-1",
      parent_tool_use_id: "spawn-1",
      message: {
        content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: {} }],
      },
    };
    sdk.query.mockReturnValue(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "session-1" };
        yield childTool;
        yield {
          type: "result",
          result: "Child output",
          session_id: "child-session",
          parent_tool_use_id: "spawn-1",
          is_error: true,
        };
        yield { type: "result", result: "Root output" };
      })(),
    );
    const callbacks: ProviderCallbacks = {
      onNativeId: vi.fn(),
      onEvent: vi.fn(),
      onUsage: vi.fn(),
      onQuestion: vi.fn(),
    };
    const handle = await new ClaudeAdapter().start(
      {
        run: {
          kind: "SESSION",
          model: "default",
          effort: null,
          webSearchEnabled: false,
          worktree: { folder: "/workspace" },
        },
        prompt: "Delegate",
        attachments: [],
      },
      callbacks,
    );
    await expect(handle.completion).resolves.toMatchObject({
      status: "COMPLETED",
      finalOutput: "Root output",
    });
    expect(sdk.query.mock.calls[0]![0].options.forwardSubagentText).toBe(true);
    expect(callbacks.onNativeId).toHaveBeenCalledOnce();
    expect(callbacks.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Bash", raw: childTool }),
    );
    expect(callbacks.onUsage).toHaveBeenCalledOnce();
  });
  test("routes the SDK process through the ownership gate and closes it before acknowledging a tracked session", async () => {
    sdk.executionEnv = { AIDE_EXECUTION_MARKER: "owned-session" };
    const close = vi.fn();
    const stream = Object.assign(
      (async function* () {
        yield { type: "result", result: "Done" };
      })(),
      { close },
    );
    sdk.query.mockReturnValue(stream);
    const handle = await new ClaudeAdapter().start(
      {
        run: {
          kind: "SESSION",
          model: "default",
          effort: null,
          webSearchEnabled: false,
          worktree: { folder: "/workspace" },
        },
        prompt: "Edit",
        attachments: [],
      },
      {
        onNativeId: vi.fn(),
        onEvent: vi.fn(),
        onUsage: vi.fn(),
        onQuestion: vi.fn(),
      },
    );
    await handle.completion;
    const options = sdk.query.mock.calls[0]![0].options;
    expect(options.env).toMatchObject({
      AIDE_EXECUTION_MARKER: "owned-session",
    });
    options.spawnClaudeCodeProcess({
      command: "claude",
      args: ["--sdk"],
      cwd: "/workspace",
      env: options.env,
    });
    expect(sdk.gatedSpawn).toHaveBeenCalledWith(
      "claude",
      ["--sdk"],
      expect.objectContaining({
        cwd: "/workspace",
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test("reports a managed session's actual transcript from a custom config directory", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/custom/claude");
    files.findClaudeSessionFile.mockResolvedValue(
      "/custom/claude/projects/workspace/session-1.jsonl",
    );
    sdk.query.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "session-1",
          cwd: "/workspace",
          claude_code_version: "2.1.0",
        };
        yield { type: "result", result: "Done" };
      })(),
    );
    const callbacks: ProviderCallbacks = {
      onNativeId: vi.fn(),
      onEvent: vi.fn(),
      onUsage: vi.fn(),
      onQuestion: vi.fn(),
    };
    const handle = await new ClaudeAdapter().start(
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
    expect(await handle.completion).toMatchObject({ status: "COMPLETED" });
    expect(files.findClaudeSessionFile).toHaveBeenCalledWith(
      "session-1",
      homedir(),
      "/custom/claude",
    );
    expect(callbacks.onNativeId).toHaveBeenCalledWith("session-1", "2.1.0", {
      workingDirectory: "/workspace",
      nativeTranscriptPath: "/custom/claude/projects/workspace/session-1.jsonl",
    });
  });
});

describe("Claude history discovery", () => {
  test("caches unchanged child files, refreshes metadata, and rereads changed or unstatable children", async () => {
    files.findClaudeSessionFile.mockResolvedValue("/project/session-1.jsonl");
    files.readClaudeTranscript.mockResolvedValue([]);
    let childModified = 1;
    let metadataModified = 1;
    files.stat.mockImplementation(async (path) => ({
      isFile: () => true,
      size: 100,
      mtimeMs: String(path).endsWith(".meta.json")
        ? metadataModified
        : childModified,
    }));
    sdk.listSubagents.mockResolvedValue(["child"]);
    const spawn = (description: string) => ({
      type: "assistant",
      uuid: "spawn-message",
      message: {
        content: [
          {
            type: "tool_use",
            id: "spawn",
            name: "Agent",
            input: { description },
          },
        ],
      },
    });
    sdk.getSessionMessages.mockResolvedValue([reply, spawn("Old label")]);
    sdk.getSubagentMessages.mockResolvedValue([
      { ...reply, parent_tool_use_id: "spawn" },
    ]);
    const adapter = new ClaudeAdapter();
    await adapter.discover(worktrees);
    await adapter.discover(worktrees);
    expect(sdk.getSubagentMessages).toHaveBeenCalledOnce();
    expect(sdk.listSubagents).toHaveBeenCalledTimes(2);
    sdk.listSessions.mockResolvedValue([{ ...session, fileSize: 1_001 }]);
    sdk.getSessionMessages.mockResolvedValue([reply, spawn("Updated label")]);
    expect((await adapter.discover(worktrees))[0]?.subagents?.[0]?.label).toBe(
      "Updated label",
    );
    expect(sdk.getSubagentMessages).toHaveBeenCalledOnce();
    childModified++;
    await adapter.discover(worktrees);
    expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(2);
    metadataModified++;
    await adapter.discover(worktrees);
    expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(3);
    files.stat.mockRejectedValue(new Error("Cannot stat file"));
    await adapter.discover(worktrees);
    expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(4);
    expect(files.stat).toHaveBeenCalledWith(
      "/project/session-1/subagents/agent-child.jsonl",
    );
  });
  test("pages child histories and refreshes them when the parent history is cached", async () => {
    sdk.listSubagents.mockResolvedValue(["agent-1"]);
    sdk.getSessionMessages.mockResolvedValue([
      reply,
      {
        type: "assistant",
        uuid: "spawn-message",
        message: {
          content: [
            {
              type: "tool_use",
              id: "spawn-1",
              name: "Agent",
              input: { description: "Inspect Swift", subagent_type: "Explore" },
            },
          ],
        },
      },
    ]);
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      type: index === 0 ? "user" : "assistant",
      uuid: `child-${index}`,
      parent_tool_use_id: "spawn-1",
      parent_agent_id: "parent-agent",
      timestamp: "2026-11-04T16:00:00Z",
      message: {
        content:
          index === 0
            ? "Inspect this file"
            : [{ type: "tool_use", name: "Read" }],
      },
    }));
    let finalText = "First result";
    sdk.getSubagentMessages.mockImplementation(
      async (_sessionId, _agentId, options) =>
        options.offset === 0
          ? firstPage
          : [
              {
                type: "assistant",
                uuid: "child-final",
                timestamp: "2026-11-04T16:01:00Z",
                message: {
                  content: [{ type: "text", text: finalText }],
                  stop_reason: "end_turn",
                },
              },
            ],
    );
    const adapter = new ClaudeAdapter();
    const [first] = await adapter.discover(worktrees);
    expect(first?.subagents?.[0]).toMatchObject({
      nativeId: "agent-1",
      parentNativeId: "parent-agent",
      toolUseId: "spawn-1",
      label: "Inspect Swift",
      agentType: "Explore",
      status: "COMPLETED",
      prompt: "Inspect this file",
      finalOutput: "First result",
      transcriptStatus: "AVAILABLE",
    });
    expect(first?.subagents?.[0]?.messages).toHaveLength(501);
    expect(sdk.getSubagentMessages).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "agent-1",
      {
        dir: "/workspace",
        limit: 500,
        offset: 500,
      },
    );
    finalText = "Updated result";
    expect(
      (await adapter.discover(worktrees))[0]?.subagents?.[0]?.finalOutput,
    ).toBe("Updated result");
    expect(sdk.getSessionMessages).toHaveBeenCalledOnce();
    expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(4);
  });

  test("keeps readable siblings when child history fails and retries failed listings", async () => {
    files.findClaudeSessionFile.mockResolvedValue("/project/session-1.jsonl");
    files.stat.mockResolvedValue({ isFile: () => true, size: 100, mtimeMs: 1 });
    sdk.listSubagents.mockResolvedValue(["good", "bad", "missing"]);
    sdk.getSubagentMessages.mockImplementation(async (_sessionId, id) => {
      if (id === "bad") throw new Error("History unavailable");
      return id === "good" ? [reply] : [];
    });
    const adapter = new ClaudeAdapter();
    const [result] = await adapter.discover(worktrees);
    expect(result?.subagents).toMatchObject([
      { nativeId: "good", transcriptStatus: "AVAILABLE" },
      {
        nativeId: "bad",
        transcriptStatus: "UNAVAILABLE",
        transcriptError: "History unavailable",
      },
      { nativeId: "missing", transcriptStatus: "UNAVAILABLE" },
    ]);
    sdk.listSubagents.mockRejectedValueOnce(new Error("Offline"));
    expect((await adapter.discover(worktrees))[0]).not.toHaveProperty(
      "subagents",
    );
    expect((await adapter.discover(worktrees))[0]?.subagents).toHaveLength(3);
    expect(
      sdk.getSubagentMessages.mock.calls.filter((call) => call[1] === "good"),
    ).toHaveLength(1);
    expect(
      sdk.getSubagentMessages.mock.calls.filter((call) => call[1] === "bad"),
    ).toHaveLength(2);
    expect(
      sdk.getSubagentMessages.mock.calls.filter(
        (call) => call[1] === "missing",
      ),
    ).toHaveLength(2);
  });

  test("marks a bounded child history as partial rather than silently truncating", async () => {
    files.findClaudeSessionFile.mockResolvedValue("/project/session-1.jsonl");
    files.stat.mockResolvedValue({ isFile: () => true, size: 100, mtimeMs: 1 });
    sdk.listSubagents.mockResolvedValue(["agent-1"]);
    sdk.getSubagentMessages.mockImplementation(
      async (_sessionId, _agentId, options) =>
        Array.from({ length: options.limit }, (_, index) => ({
          ...reply,
          uuid: `message-${options.offset + index}`,
        })),
    );
    const adapter = new ClaudeAdapter();
    const [result] = await adapter.discover(worktrees);
    expect(result?.subagents?.[0]).toMatchObject({
      nativeId: "agent-1",
      transcriptStatus: "PARTIAL",
      transcriptError: "Subagent transcript message limit reached.",
    });
    expect(result?.subagents?.[0]?.messages).toHaveLength(10_000);
    expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(20);
    await adapter.discover(worktrees);
    expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(40);
  });
  test("refreshes moved transcript locations without rehydrating unchanged history", async () => {
    files.findClaudeSessionFile
      .mockResolvedValueOnce("/previous/session-1.jsonl")
      .mockResolvedValueOnce("/moved/session-1.jsonl")
      .mockResolvedValueOnce(null);
    files.readClaudeTranscript.mockResolvedValue([]);
    const adapter = new ClaudeAdapter();
    expect(
      (await adapter.discover(worktrees))[0]?.sessionInfo?.nativeTranscriptPath,
    ).toBe("/previous/session-1.jsonl");
    expect(
      (await adapter.discover(worktrees))[0]?.sessionInfo?.nativeTranscriptPath,
    ).toBe("/moved/session-1.jsonl");
    expect((await adapter.discover(worktrees))[0]?.sessionInfo).toEqual({
      workingDirectory: "/workspace",
    });
    expect(sdk.getSessionMessages).toHaveBeenCalledOnce();
    expect(files.readClaudeTranscript).toHaveBeenCalledOnce();
  });

  test("hydrates complete history with transcript effort, prompt and reported cost", async () => {
    const user = {
      type: "user",
      uuid: "user-1",
      message: { content: "Complete original prompt" },
    };
    const messages = [
      user,
      ...Array.from({ length: 500 }, (_, index) => ({
        type: "system",
        uuid: `system-${index}`,
        subtype: "turn_duration",
      })),
      reply,
    ];
    sdk.getSessionMessages.mockResolvedValue(messages);
    files.findClaudeSessionFile.mockResolvedValue("/transcript.jsonl");
    files.readClaudeTranscript.mockResolvedValue([
      { ...user, permissionMode: "plan" },
      { ...reply, perTurnEffort: "high" },
      {
        type: "cost-state",
        totalCostUSD: 0.2,
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 10,
            outputTokens: 20,
            costUSD: 0.2,
          },
        },
      },
    ]);
    const adapter = new ClaudeAdapter();
    const [imported] = await adapter.discover(worktrees);
    expect(imported).toMatchObject({
      nativeId: "session-1",
      worktreeId: "worktree-1",
      prompt: "Complete original prompt",
      kind: "PLAN",
      model: "claude-sonnet-5",
      effort: "high",
      finalOutput: "Done",
      estimatedCost: 0.2,
      pricingSource: "claude-transcript",
      sessionInfo: {
        workingDirectory: "/workspace",
        nativeTranscriptPath: "/transcript.jsonl",
      },
      usage: [{ inputTokens: 10, estimatedCost: 0.2 }],
    });
    expect(imported?.events).toHaveLength(502);
    expect(sdk.listSessions).toHaveBeenCalledWith({
      dir: "/workspace",
      includeWorktrees: false,
    });
    expect(sdk.getSessionMessages).toHaveBeenCalledWith("session-1", {
      dir: "/workspace",
      includeSystemMessages: true,
    });
    await adapter.discover(worktrees);
    expect(sdk.getSessionMessages).toHaveBeenCalledOnce();
    expect((await adapter.discover(worktrees))[0]?.sessionInfo).toEqual({
      workingDirectory: "/workspace",
      nativeTranscriptPath: "/transcript.jsonl",
    });
    sdk.listSessions.mockResolvedValue([{ ...session, fileSize: 1_001 }]);
    await adapter.discover(worktrees);
    expect(sdk.getSessionMessages).toHaveBeenCalledTimes(2);
  });

  test("uses SDK model and usage when the transcript cannot be read", async () => {
    files.findClaudeSessionFile.mockRejectedValue(new Error("Unavailable"));
    const [imported] = await new ClaudeAdapter().discover(worktrees);
    expect(imported).toMatchObject({
      model: "claude-sonnet-5",
      finalOutput: "Done",
      usage: [{ inputTokens: 10, outputTokens: 20 }],
      sessionInfo: { workingDirectory: "/workspace" },
    });
    expect(imported).not.toHaveProperty("estimatedCost");
  });

  test("retries failed and empty SDK histories without erasing previous activity", async () => {
    sdk.getSessionMessages
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce([]);
    const adapter = new ClaudeAdapter();
    for (let index = 0; index < 2; index++) {
      const [imported] = await adapter.discover(worktrees);
      expect(imported).not.toHaveProperty("events");
      expect(imported).not.toHaveProperty("finalOutput");
    }
    expect((await adapter.discover(worktrees))[0]?.finalOutput).toBe("Done");
    expect(sdk.getSessionMessages).toHaveBeenCalledTimes(3);
  });
});
