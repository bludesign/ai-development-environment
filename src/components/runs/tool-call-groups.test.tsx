import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ToolCallGroups } from "./tool-call-groups";
import type { AgentRunView } from "./types";

type ToolCall = AgentRunView["toolCalls"][number];
function call(id: string, name: string, input: unknown = null): ToolCall {
  return {
    id,
    sequence: Number(id),
    name,
    input,
    output: null,
    error: null,
    status: "COMPLETED",
    startedAt: "2026-09-30T12:00:00Z",
    finishedAt: null,
    supersededAt: null,
  };
}
afterEach(cleanup);

describe("ToolCallGroups", () => {
  test("combines different commands into one collapsed category and expands individual details", () => {
    const output = "output-token".repeat(100);
    render(
      <ToolCallGroups
        calls={[
          call("0", "npm test", {
            params: { item: { type: "commandExecution", command: "npm test" } },
          }),
          {
            ...call("1", "node long-script", {
              params: { item: { type: "commandExecution" } },
            }),
            output,
          },
          call("2", "apply_patch", {
            params: { item: { type: "fileChange" } },
          }),
          call("3", "get_issue", {
            params: { item: { type: "mcpToolCall", server: "jira" } },
          }),
        ]}
      />,
    );
    const summary = screen.getByText("Commands").closest("summary")!;
    expect(within(summary).getByText("2")).toBeDefined();
    const group = summary.parentElement as HTMLDetailsElement;
    expect(group.open).toBe(false);
    fireEvent.click(summary);
    expect(group.open).toBe(true);
    const command = within(group)
      .getByText("node long-script")
      .closest("details") as HTMLDetailsElement;
    expect(command.open).toBe(false);
    fireEvent.click(command.querySelector("summary")!);
    expect(command.open).toBe(true);
    expect(command.querySelector("pre")?.textContent).toContain(output);
    expect(command.querySelector("pre")?.textContent).toContain(
      "node long-script",
    );
    expect(screen.getByText("File changes")).toBeDefined();
    expect(screen.getByText("MCP calls")).toBeDefined();
  });

  test("shows search queries in the expanded web-search group", () => {
    const query = "Codex thread history documentation";
    render(
      <ToolCallGroups
        calls={[
          call("0", "webSearch", {
            params: { item: { type: "webSearch", query } },
          }),
          call("1", "webSearch", {
            params: {
              item: {
                type: "webSearch",
                action: { type: "search", queries: ["query one", "query two"] },
              },
            },
          }),
          call("2", "WebSearch", {
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "WebSearch",
                  input: { query: "Claude search query" },
                },
              ],
            },
          }),
          call("3", "websearch", {
            properties: {
              part: {
                tool: "websearch",
                state: { input: { query: "OpenCode search query" } },
              },
            },
          }),
          call("4", "webSearch", { params: { item: { type: "webSearch" } } }),
        ]}
      />,
    );
    const group = screen
      .getByText("Web search")
      .closest("details") as HTMLDetailsElement;
    expect(
      within(group.querySelector("summary")!).getByText("5"),
    ).toBeDefined();
    fireEvent.click(group.querySelector("summary")!);
    expect(group.open).toBe(true);
    const queryLabel = within(group).getByText(query);
    expect(queryLabel.title).toBe(query);
    expect(within(group).getByText("query one · query two")).toBeDefined();
    expect(within(group).getByText("Claude search query")).toBeDefined();
    expect(within(group).getByText("OpenCode search query")).toBeDefined();
    expect(within(group).getByText("webSearch")).toBeDefined();
  });

  test("groups provider-native tools and preserves failed or superseded call details", () => {
    render(
      <ToolCallGroups
        calls={[
          call("0", "Bash"),
          call("1", "irrelevant", { properties: { part: { tool: "bash" } } }),
          call("2", "Claude call", {
            message: { content: [{ type: "tool_use", name: "Read" }] },
          }),
          {
            ...call("3", "mcp__jira__issue"),
            status: "FAILED",
            error: "Missing issue",
            supersededAt: "2026-09-30T13:00:00Z",
          },
          call("4", "custom_tool"),
        ]}
      />,
    );
    const commandSummary = screen.getByText("Commands").closest("summary")!;
    expect(within(commandSummary).getByText("2")).toBeDefined();
    expect(screen.getByText("File reads")).toBeDefined();
    expect(screen.getByText("Custom Tool")).toBeDefined();
    const failed = screen.getByText("mcp__jira__issue").closest("details")!;
    expect(within(failed).getByText("Failed")).toBeDefined();
    expect(within(failed).getByText("Superseded")).toBeDefined();
    expect(failed.querySelector("pre")?.textContent).toContain("Missing issue");
  });
});
