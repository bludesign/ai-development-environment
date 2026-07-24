import { describe, expect, test } from "vitest";
import {
  Brain,
  CheckCircle2,
  Gauge,
  MessageSquare,
  Server,
  Terminal,
} from "lucide-react";

import {
  codexMethod,
  describeActivity,
  formatMethodTitle,
  groupActivity,
  itemGroupTitle,
  truncateJson,
} from "./activity";
import type { RunEventView } from "./types";

function event(overrides: Partial<RunEventView>): RunEventView {
  return {
    id: overrides.id ?? "event",
    runId: "run",
    attemptId: null,
    sequence: overrides.sequence ?? 0,
    type: overrides.type ?? "PROVIDER",
    summary: overrides.summary ?? "",
    detailMarkdown: overrides.detailMarkdown ?? null,
    raw: overrides.raw ?? null,
    createdAt: "2026-07-23T19:41:36.000Z",
    supersededAt: overrides.supersededAt ?? null,
  };
}

function codex(
  method: string,
  params: unknown,
  overrides: Partial<RunEventView> = {},
) {
  return event({
    type: method.toUpperCase().replaceAll("/", "_"),
    raw: { method, params },
    ...overrides,
  });
}

function opencode(
  type: string,
  properties: unknown,
  overrides: Partial<RunEventView> = {},
) {
  return event({
    type: type.toUpperCase().replaceAll(".", "_"),
    summary: type,
    raw: { id: `raw:${overrides.id ?? "event"}`, type, properties },
    ...overrides,
  });
}

function claude(
  type: string,
  raw: Record<string, unknown>,
  overrides: Partial<RunEventView> = {},
) {
  return event({
    type: type.toUpperCase(),
    raw: { type, session_id: "session", uuid: "uuid", ...raw },
    ...overrides,
  });
}

describe("formatMethodTitle", () => {
  test("splits camel case and delimiters into words", () => {
    expect(formatMethodTitle("mcpServer/startupStatus/updated")).toBe(
      "Mcp Server Startup Status Updated",
    );
    expect(formatMethodTitle("item/agentMessage/delta")).toBe(
      "Item Agent Message Delta",
    );
    expect(formatMethodTitle("thread/tokenUsage/updated")).toBe(
      "Thread Token Usage Updated",
    );
  });

  test("drops symbol-only segments", () => {
    expect(formatMethodTitle("$/serverDisconnected")).toBe(
      "Server Disconnected",
    );
  });
});

describe("codexMethod", () => {
  test("reads the JSON-RPC method from the raw envelope", () => {
    expect(codexMethod(codex("turn/started", {}))).toBe("turn/started");
    expect(
      codexMethod(event({ type: "SYSTEM", raw: { type: "system" } })),
    ).toBeNull();
  });
});

describe("describeActivity", () => {
  test("parses token usage into a line and detail rows", () => {
    const descriptor = describeActivity(
      codex("thread/tokenUsage/updated", {
        tokenUsage: {
          total: {
            totalTokens: 12907,
            inputTokens: 12774,
            cachedInputTokens: 0,
            outputTokens: 133,
            reasoningOutputTokens: 24,
          },
          modelContextWindow: 258400,
        },
      }),
      "en-US",
    );
    expect(descriptor.icon).toBe(Gauge);
    expect(descriptor.methodTitle).toBe("Thread Token Usage Updated");
    expect(descriptor.line).toContain("12,774");
    expect(descriptor.line).toContain("258.4K ctx");
    expect(descriptor.detailRows).toContainEqual({
      label: "Context window",
      value: "258,400",
    });
    expect(descriptor.detailRows).toContainEqual({
      label: "Reasoning",
      value: "24",
    });
  });

  test("parses a thread status change", () => {
    const descriptor = describeActivity(
      codex("thread/status/changed", { status: { type: "idle" } }),
    );
    expect(descriptor.line).toBe("Idle");
    expect(descriptor.detailRows).toContainEqual({
      label: "Status",
      value: "Idle",
    });
  });

  test("parses a completed turn with its duration", () => {
    const descriptor = describeActivity(
      codex("turn/completed", {
        turn: {
          id: "019f907f-677a-75d3",
          status: "completed",
          durationMs: 8206,
        },
      }),
    );
    expect(descriptor.line).toContain("Completed");
    expect(descriptor.line).toContain("8.2s");
    expect(descriptor.detailRows).toContainEqual({
      label: "Duration",
      value: "8.2s",
    });
  });

  test("summarizes thread settings", () => {
    const descriptor = describeActivity(
      codex("thread/settings/updated", {
        threadSettings: {
          model: "gpt-5.6-luna",
          effort: "low",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          collaborationMode: { mode: "plan" },
        },
      }),
    );
    expect(descriptor.line).toBe("gpt-5.6-luna · low · plan");
    expect(descriptor.detailRows).toContainEqual({
      label: "Sandbox",
      value: "Read Only",
    });
    expect(descriptor.detailRows).toContainEqual({
      label: "Network access",
      value: "No",
    });
  });

  test("labels an MCP server startup status", () => {
    const descriptor = describeActivity(
      codex("mcpServer/startupStatus/updated", {
        name: "node_repl",
        status: "ready",
      }),
    );
    expect(descriptor.icon).toBe(Server);
    expect(descriptor.line).toBe("node_repl · Ready");
  });

  test("uses the item's text and icon for an agent message item", () => {
    const descriptor = describeActivity(
      codex("item/started", {
        item: {
          type: "agentMessage",
          id: "msg_1",
          text: "You chose: REST API.",
          phase: "final_answer",
        },
      }),
    );
    expect(descriptor.icon).toBe(MessageSquare);
    expect(descriptor.line).toBe("You chose: REST API.");
    expect(descriptor.detailRows).toContainEqual({
      label: "Phase",
      value: "final_answer",
    });
    expect(descriptor.detailRows).not.toContainEqual(
      expect.objectContaining({ label: "Id" }),
    );
  });

  test("falls back to the item type when it carries no text", () => {
    const descriptor = describeActivity(
      codex("item/started", {
        item: { type: "reasoning", id: "rs_1", summary: [], content: [] },
      }),
    );
    expect(descriptor.icon).toBe(Brain);
    expect(descriptor.line).toBe("Reasoning");
  });

  test("falls back to a truncated params rendering for unknown methods", () => {
    const descriptor = describeActivity(
      codex("thread/custom/event", { foo: "bar" }),
    );
    expect(descriptor.line).toBe('{"foo":"bar"}');
    expect(descriptor.detailRows).toEqual([]);
  });

  test("keeps the agent's own events on their summary", () => {
    const descriptor = describeActivity(
      event({
        type: "ASSISTANT",
        summary: "Working on it",
        raw: { type: "assistant" },
      }),
    );
    expect(descriptor.methodTitle).toBeNull();
    expect(descriptor.line).toBe("Working on it");
  });

  test("parses a completed OpenCode tool part", () => {
    const descriptor = describeActivity(
      opencode("message.part.updated", {
        part: {
          id: "part_1",
          messageID: "message_1",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            title: "git status",
            input: { command: "git status" },
            output: "On branch feature/activity",
            metadata: { exit: 0 },
            time: { start: 1_000, end: 1_128 },
          },
        },
      }),
    );
    expect(descriptor.icon).toBe(Terminal);
    expect(descriptor.methodTitle).toBe("Bash Tool");
    expect(descriptor.line).toBe("git status · Completed · 128ms · exit 0");
    expect(descriptor.detailRows).toContainEqual({
      label: "Output",
      value: "On branch feature/activity",
    });
  });

  test("summarizes OpenCode step usage and cost", () => {
    const descriptor = describeActivity(
      opencode("message.part.updated", {
        part: {
          id: "part_1",
          messageID: "message_1",
          type: "step-finish",
          reason: "tool-calls",
          tokens: { total: 10_019, input: 9_887, output: 111, reasoning: 21 },
          cost: 0.00142114,
        },
      }),
      "en-US",
    );
    expect(descriptor.methodTitle).toBe("Step Finished");
    expect(descriptor.line).toContain("↑9,887");
    expect(descriptor.line).toContain("$0.001421");
    expect(descriptor.detailRows).toContainEqual({
      label: "Reasoning tokens",
      value: "21",
    });
  });

  test("formats Claude initialization metadata", () => {
    const descriptor = describeActivity(
      claude("system", {
        subtype: "init",
        model: "claude-sonnet-5",
        claude_code_version: "2.1.216",
        permissionMode: "bypassPermissions",
        cwd: "/repo",
        tools: ["Bash", "Read"],
        agents: ["Explore", "Plan"],
        skills: ["verify"],
        plugins: [{ name: "review" }],
        mcp_servers: [{ name: "codegraph", status: "connected" }],
      }),
    );
    expect(descriptor.methodTitle).toBe("Claude Initialization");
    expect(descriptor.line).toContain("claude-sonnet-5");
    expect(descriptor.detailRows).toContainEqual({
      label: "MCP servers",
      value: "codegraph · Connected",
    });
  });

  test("formats a Claude result as execution metrics instead of repeated output", () => {
    const descriptor = describeActivity(
      claude("result", {
        subtype: "success",
        is_error: false,
        duration_ms: 16_137,
        duration_api_ms: 13_518,
        ttft_ms: 1_818,
        num_turns: 3,
        total_cost_usd: 0.0749253,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 6,
          output_tokens: 1_118,
          cache_read_input_tokens: 50_051,
        },
      }),
      "en-US",
    );
    expect(descriptor.icon).toBe(CheckCircle2);
    expect(descriptor.methodTitle).toBe("Result");
    expect(descriptor.line).toBe("Success · 16.1s · 3 turns · $0.07");
    expect(descriptor.detailRows).toContainEqual({
      label: "Cache read tokens",
      value: "50,051",
    });
  });
});

describe("truncateJson", () => {
  test("collapses whitespace and truncates", () => {
    expect(truncateJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(truncateJson({}, 10)).toBe("");
    expect(truncateJson({ value: "x".repeat(300) }).endsWith("…")).toBe(true);
  });
});

describe("groupActivity", () => {
  test("folds an item lifecycle into a single group with children", () => {
    const nodes = groupActivity([
      codex(
        "item/started",
        { item: { type: "agentMessage", id: "msg_1", text: "" } },
        { id: "a", sequence: 1 },
      ),
      codex(
        "item/agentMessage/delta",
        { itemId: "msg_1", delta: "You" },
        { id: "b", sequence: 2 },
      ),
      codex(
        "item/agentMessage/delta",
        { itemId: "msg_1", delta: " chose" },
        { id: "c", sequence: 3 },
      ),
      codex(
        "item/completed",
        {
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "You chose: REST API.",
          },
        },
        { id: "d", sequence: 4 },
      ),
    ]);
    expect(nodes).toHaveLength(1);
    const group = nodes[0]!;
    expect(group.kind).toBe("group");
    if (group.kind !== "group") return;
    expect(group.children).toHaveLength(4);
    expect(group.representative.id).toBe("d");
    expect(itemGroupTitle(group.representative)).toBe("Agent Message");
    expect(describeActivity(group.representative).line).toBe(
      "You chose: REST API.",
    );
  });

  test("leaves other events as single rows and closes groups on completion", () => {
    const nodes = groupActivity([
      codex(
        "turn/started",
        { turn: { id: "t1", status: "inProgress" } },
        { id: "t", sequence: 1 },
      ),
      codex(
        "item/started",
        { item: { type: "reasoning", id: "rs_1" } },
        { id: "a", sequence: 2 },
      ),
      codex(
        "item/completed",
        { item: { type: "reasoning", id: "rs_1" } },
        { id: "b", sequence: 3 },
      ),
      codex(
        "item/completed",
        { item: { type: "reasoning", id: "orphan" } },
        { id: "c", sequence: 4 },
      ),
    ]);
    expect(nodes.map((node) => node.kind)).toEqual([
      "single",
      "group",
      "single",
    ]);
  });

  test("combines OpenCode deltas by part id into one rendered result", () => {
    const nodes = groupActivity([
      opencode(
        "message.part.delta",
        {
          messageID: "message_1",
          partID: "part_1",
          field: "text",
          delta: "The user",
        },
        { id: "a", sequence: 1 },
      ),
      opencode(
        "message.part.delta",
        {
          messageID: "message_1",
          partID: "part_1",
          field: "text",
          delta: " wants a commit.",
        },
        { id: "b", sequence: 2 },
      ),
      opencode(
        "message.updated",
        { info: { id: "message_1", role: "assistant", finish: "tool-calls" } },
        { id: "c", sequence: 3 },
      ),
    ]);
    expect(nodes).toHaveLength(2);
    const group = nodes[0]!;
    expect(group.kind).toBe("group");
    if (group.kind !== "group") return;
    expect(group.detailMode).toBe("representative");
    expect(group.children).toHaveLength(2);
    expect(group.representative.type).toBe("REASONING");
    expect(group.representative.summary).toBe("The user wants a commit.");
    expect(group.representative.raw).toHaveLength(2);
  });

  test("uses the last of multiple OpenCode text parts as the assistant message", () => {
    const nodes = groupActivity([
      opencode(
        "message.part.delta",
        { messageID: "message_1", partID: "reasoning", delta: "Done." },
        { id: "a", sequence: 1 },
      ),
      opencode(
        "message.part.delta",
        { messageID: "message_1", partID: "answer", delta: "Committed " },
        { id: "b", sequence: 2 },
      ),
      opencode(
        "message.part.delta",
        { messageID: "message_1", partID: "answer", delta: "successfully." },
        { id: "c", sequence: 3 },
      ),
    ]);
    expect(nodes).toHaveLength(2);
    const answer = nodes[1]!;
    expect(answer.kind).toBe("group");
    if (answer.kind !== "group") return;
    expect(answer.representative.type).toBe("ASSISTANT_MESSAGE");
    expect(itemGroupTitle(answer.representative)).toBe("Assistant Message");
    expect(answer.representative.summary).toBe("Committed successfully.");
  });

  test("folds OpenCode tool updates into their completed state", () => {
    const nodes = groupActivity([
      opencode(
        "message.part.updated",
        {
          part: {
            id: "part_1",
            messageID: "message_1",
            type: "tool",
            tool: "bash",
            state: { status: "pending", input: {} },
          },
        },
        { id: "a", sequence: 1 },
      ),
      opencode(
        "message.part.updated",
        {
          part: {
            id: "part_1",
            messageID: "message_1",
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              title: "git status",
              input: { command: "git status" },
              output: "clean",
            },
          },
        },
        { id: "b", sequence: 2 },
      ),
    ]);
    expect(nodes).toHaveLength(1);
    const group = nodes[0]!;
    expect(group.kind).toBe("group");
    if (group.kind !== "group") return;
    expect(group.detailMode).toBe("representative");
    expect(group.representative.id).toBe("b");
    expect(describeActivity(group.representative).line).toContain("Completed");
  });
});
