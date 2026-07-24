import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ActivityRows } from "./activity-rows";
import type { RunEventView } from "./types";

function renderRows(events: RunEventView[]) {
  return render(
    <table>
      <tbody>
        <ActivityRows events={events} />
      </tbody>
    </table>,
  );
}

function codexEvent(
  method: string,
  params: unknown,
  id: string,
  sequence = 0,
): RunEventView {
  return {
    id,
    runId: "run",
    attemptId: null,
    sequence,
    type: method.toUpperCase().replaceAll("/", "_"),
    summary: method,
    detailMarkdown: null,
    raw: { method, params },
    createdAt: "2026-07-23T19:41:36.000Z",
    supersededAt: null,
  };
}

function opencodeEvent(
  type: string,
  properties: unknown,
  id: string,
  sequence = 0,
): RunEventView {
  return {
    id,
    runId: "run",
    attemptId: null,
    sequence,
    type: type.toUpperCase().replaceAll(".", "_"),
    summary: type,
    detailMarkdown: null,
    raw: { id: `raw:${id}`, type, properties },
    createdAt: "2026-07-23T19:41:36.000Z",
    supersededAt: null,
  };
}

function claudeEvent(
  type: string,
  raw: Record<string, unknown>,
  id: string,
): RunEventView {
  return {
    id,
    runId: "run",
    attemptId: null,
    sequence: 0,
    type: type.toUpperCase(),
    summary: type,
    detailMarkdown: null,
    raw: { type, session_id: "session", uuid: id, ...raw },
    createdAt: "2026-07-23T19:41:36.000Z",
    supersededAt: null,
  };
}

afterEach(() => cleanup());

describe("ActivityRows", () => {
  test("humanizes a Codex method badge and parses its summary line", () => {
    renderRows([
      codexEvent(
        "mcpServer/startupStatus/updated",
        { name: "node_repl", status: "ready" },
        "e1",
      ),
    ]);
    expect(screen.getByText("Mcp Server Startup Status Updated")).toBeDefined();
    expect(screen.getByText("node_repl · Ready")).toBeDefined();
  });

  test("shows context window and token counts for a token usage event", () => {
    renderRows([
      codexEvent(
        "thread/tokenUsage/updated",
        {
          tokenUsage: {
            total: {
              totalTokens: 12907,
              inputTokens: 12774,
              outputTokens: 133,
            },
            modelContextWindow: 258400,
          },
        },
        "u1",
      ),
    ]);
    expect(screen.getByText(/258\.4K ctx/)).toBeDefined();
    expect(screen.getByText(/12,774/)).toBeDefined();
  });

  test("folds an item lifecycle into one expandable group", () => {
    renderRows([
      codexEvent(
        "item/started",
        { item: { type: "agentMessage", id: "m", text: "" } },
        "a",
        1,
      ),
      codexEvent(
        "item/agentMessage/delta",
        { itemId: "m", delta: "You" },
        "b",
        2,
      ),
      codexEvent(
        "item/completed",
        {
          item: { type: "agentMessage", id: "m", text: "You chose: REST API." },
        },
        "d",
        3,
      ),
    ]);
    expect(screen.getByText("Agent Message")).toBeDefined();
    // Children stay hidden until the group is expanded.
    expect(screen.queryByText("Item Agent Message Delta")).toBeNull();
    fireEvent.click(screen.getByText("You chose: REST API."));
    expect(screen.getByText("Item Agent Message Delta")).toBeDefined();
    expect(screen.getByText("Item Started")).toBeDefined();
    expect(screen.getByText("Item Completed")).toBeDefined();
  });

  test("shows only the raw payload with a copy button when nothing is parsed", () => {
    renderRows([codexEvent("thread/custom/thing", { foo: "bar" }, "x")]);
    fireEvent.click(screen.getByText('{"foo":"bar"}'));
    expect(screen.getByRole("button", { name: "Copy" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Rendered" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
  });

  test("offers a raw toggle when an event has parsed detail", () => {
    renderRows([
      codexEvent("thread/status/changed", { status: { type: "idle" } }, "s1"),
    ]);
    fireEvent.click(screen.getByText("Idle"));
    const toggle = screen.getByRole("button", { name: "Raw" });
    expect(toggle).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Copy" })).toBeDefined();
  });

  test("shows OpenCode message deltas as one expandable rendered message", () => {
    renderRows([
      opencodeEvent(
        "message.part.delta",
        {
          messageID: "message",
          partID: "part",
          field: "text",
          delta: "The user",
        },
        "a",
        1,
      ),
      opencodeEvent(
        "message.part.delta",
        {
          messageID: "message",
          partID: "part",
          field: "text",
          delta: " wants a commit.",
        },
        "b",
        2,
      ),
      opencodeEvent(
        "message.updated",
        { info: { id: "message", role: "assistant", finish: "tool-calls" } },
        "c",
        3,
      ),
    ]);
    expect(screen.getByText("The user wants a commit.")).toBeDefined();
    expect(screen.getByText("Reasoning")).toBeDefined();
    expect(screen.queryByText("Message Text Delta")).toBeNull();
    fireEvent.click(screen.getByText("The user wants a commit."));
    expect(screen.getByRole("button", { name: "Raw" })).toBeDefined();
    expect(screen.queryByText("Message Text Delta")).toBeNull();
  });

  test("expands an OpenCode tool lifecycle into a structured result table", () => {
    renderRows([
      opencodeEvent(
        "message.part.updated",
        {
          part: {
            id: "part",
            messageID: "message",
            type: "tool",
            tool: "bash",
            state: { status: "pending", input: {} },
          },
        },
        "a",
        1,
      ),
      opencodeEvent(
        "message.part.updated",
        {
          part: {
            id: "part",
            messageID: "message",
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              title: "git status",
              input: { command: "git status" },
              output: "On branch feature/activity",
              metadata: { exit: 0 },
            },
          },
        },
        "b",
        2,
      ),
    ]);
    fireEvent.click(screen.getByText(/git status · Completed/));
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("On branch feature/activity")).toBeDefined();
    expect(screen.getByRole("button", { name: "Raw" })).toBeDefined();
  });

  test("wraps expanded detail instead of widening the activity table", () => {
    const { container } = renderRows([
      codexEvent("thread/status/changed", { status: { type: "idle" } }, "s1"),
    ]);
    fireEvent.click(screen.getByText("Idle"));
    const detail = container.querySelector("td[colspan='4']");
    expect(detail).not.toBeNull();
    // `TableCell` defaults to `whitespace-nowrap`, which would push the whole
    // feed into a horizontal scroll once the panel holds long content.
    const classes = detail!.className.split(" ");
    expect(classes).toContain("whitespace-normal");
    expect(classes).not.toContain("whitespace-nowrap");
  });

  test("shows Claude result metrics in the row and expanded table", () => {
    renderRows([
      claudeEvent(
        "result",
        {
          subtype: "success",
          is_error: false,
          duration_ms: 16_137,
          duration_api_ms: 13_518,
          ttft_ms: 1_818,
          num_turns: 3,
          total_cost_usd: 0.0749253,
          usage: { input_tokens: 6, output_tokens: 1_118 },
        },
        "result",
      ),
    ]);
    fireEvent.click(screen.getByText("Success · 16.1s · 3 turns · $0.07"));
    expect(screen.getByText("API duration")).toBeDefined();
    expect(screen.getByText("13.5s")).toBeDefined();
    expect(screen.getByRole("button", { name: "Raw" })).toBeDefined();
  });
});
