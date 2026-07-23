import { describe, expect, test } from "vitest";
import { Brain, Gauge, MessageSquare, Server } from "lucide-react";

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
});
