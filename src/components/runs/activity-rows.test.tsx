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
});
