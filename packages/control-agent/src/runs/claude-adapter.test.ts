import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProviderCallbacks, ProviderStartInput } from "./provider.js";

const sdk = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
  deleteSession: vi.fn(),
}));
const files = vi.hoisted(() => ({
  findClaudeSessionFile: vi.fn(),
  readClaudeTranscript: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);
vi.mock("../handlers/runs.js", () => ({
  findClaudeSessionFile: files.findClaudeSessionFile,
}));
vi.mock("./claude-import.js", async (original) => ({
  ...(await original<typeof import("./claude-import.js")>()),
  readClaudeTranscript: files.readClaudeTranscript,
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
  sdk.listSessions.mockResolvedValue([{ ...session }]);
  sdk.getSessionMessages.mockResolvedValue([reply]);
  files.findClaudeSessionFile.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claude session info", () => {
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
