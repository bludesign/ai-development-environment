import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { RunAgentsCard } from "./run-agents-card";
import type {
  RunEventView,
  RunSubagentMessagePageView,
  RunSubagentView,
} from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);
let agents: RunSubagentView[];
let pages: Record<string, RunSubagentMessagePageView>;

function agent(
  number: number,
  overrides: Partial<RunSubagentView> = {},
): RunSubagentView {
  return {
    id: `agent-${number}`,
    runId: "run-1",
    attemptId: "attempt-1",
    nativeId: `native-${number}`,
    parentNativeId: null,
    toolUseId: `tool-${number}`,
    label: `Swift picker ${number}`,
    agentType: "Explore",
    status: "COMPLETED",
    prompt: `Find Swift file ${number}`,
    finalOutput: `Picked file ${number}.swift`,
    startedAt: "2026-11-04T16:13:23.000Z",
    finishedAt: "2026-11-04T16:13:30.000Z",
    transcriptStatus: "AVAILABLE",
    transcriptError: null,
    messageCount: 3,
    updatedAt: "2026-11-04T16:13:30.000Z",
    ...overrides,
  };
}

function event(
  id: string,
  createdAt = "2026-11-04T16:13:25.000Z",
  sequence = 1,
): RunEventView {
  return {
    id,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    type: "SYSTEM",
    summary: id,
    detailMarkdown: null,
    raw: null,
    createdAt,
    supersededAt: null,
  };
}

function messageCalls() {
  return request.mock.calls.filter(([query]) =>
    String(query).includes("query RunSubagentMessages"),
  );
}

beforeEach(() => {
  agents = [agent(1), agent(2), agent(3), agent(4)];
  pages = Object.fromEntries(
    agents.map((value) => [
      `${value.id}:latest`,
      { events: [event(`${value.id} activity`)], nextCursor: null },
    ]),
  );
  request.mockReset();
  request.mockImplementation(async (query, variables) => {
    if (String(query).includes("query RunSubagents"))
      return { runSubagents: agents } as never;
    if (String(query).includes("query RunSubagentMessages")) {
      const { subagentId, before } = variables as {
        subagentId: string;
        before: string | null;
      };
      return {
        runSubagentMessages: pages[`${subagentId}:${before ?? "latest"}`],
      } as never;
    }
    throw new Error(`Unexpected query: ${String(query)}`);
  });
});

afterEach(() => cleanup());

describe("RunAgentsCard", () => {
  test("discovers all agents independently and lazily expands isolated cached sessions", async () => {
    render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    const first = await screen.findByRole("button", { name: /Swift picker 1/ });
    const fourth = screen.getByRole("button", { name: /Swift picker 4/ });
    expect(
      screen.getAllByRole("button", { name: /Swift picker/ }),
    ).toHaveLength(4);
    expect(messageCalls()).toHaveLength(0);
    expect(first.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(first);
    expect(await screen.findByText("agent-1 activity")).toBeDefined();
    expect(screen.getByText("Find Swift file 1")).toBeDefined();
    expect(screen.getByText("Picked file 1.swift")).toBeDefined();
    expect(screen.queryByText("agent-2 activity")).toBeNull();
    fireEvent.click(fourth);
    expect(await screen.findByText("agent-4 activity")).toBeDefined();
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(fourth.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(first);
    fireEvent.click(first);
    expect(screen.getByText("agent-1 activity")).toBeDefined();
    expect(messageCalls()).toHaveLength(3);
    expect(messageCalls()[0]?.[1]).toEqual({
      runId: "run-1",
      subagentId: "agent-1",
      before: null,
      first: 200,
    });
  });

  test("paginates older messages, sorts by chronology, and preserves them across live refreshes", async () => {
    agents = [agent(1)];
    const recent = event("recent message", "2026-11-04T16:13:29.000Z", 1);
    const old = event("older message", "2026-11-04T16:13:24.000Z", 9000);
    pages["agent-1:latest"] = { events: [recent], nextCursor: "older-cursor" };
    pages["agent-1:older-cursor"] = { events: [old, recent], nextCursor: null };
    const { rerender } = render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Swift picker 1/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("older message")).toBeDefined();
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Activity"),
      expect.stringContaining("older message"),
      expect.stringContaining("recent message"),
    ]);
    pages["agent-1:latest"] = {
      events: [recent, event("latest message", "2026-11-04T16:13:31.000Z")],
      nextCursor: "shifted-cursor",
    };
    rerender(<RunAgentsCard refreshKey={1} runId="run-1" />);
    expect(await screen.findByText("latest message")).toBeDefined();
    expect(screen.getByText("older message")).toBeDefined();
    expect(screen.getAllByText("recent message")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("refreshes lifecycle summaries and only the expanded agent session", async () => {
    agents = [agent(1, { status: "RUNNING", finalOutput: null }), agent(2)];
    const { rerender } = render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Swift picker 1.*Running/ }),
    );
    expect(await screen.findByText("agent-1 activity")).toBeDefined();
    agents = [agent(1), agent(2)];
    pages["agent-1:latest"] = {
      events: [event("agent-1 activity"), event("agent-1 finished")],
      nextCursor: null,
    };
    rerender(<RunAgentsCard refreshKey={1} runId="run-1" />);
    expect(
      await screen.findByRole("button", { name: /Swift picker 1.*Completed/ }),
    ).toBeDefined();
    expect(await screen.findByText("agent-1 finished")).toBeDefined();
    expect(
      messageCalls().map(
        ([, variables]) => (variables as { subagentId: string }).subagentId,
      ),
    ).toEqual(["agent-1", "agent-1"]);
  });

  test("refreshes a cached transcript when reopened after completing while collapsed", async () => {
    agents = [agent(1, { status: "RUNNING", finalOutput: null })];
    const { rerender } = render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Swift picker 1.*Running/ }),
    );
    expect(await screen.findByText("agent-1 activity")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Swift picker 1/ }));

    agents = [agent(1, { messageCount: 4 })];
    pages["agent-1:latest"] = {
      events: [event("agent-1 activity"), event("agent-1 finished")],
      nextCursor: null,
    };
    rerender(<RunAgentsCard refreshKey={1} runId="run-1" />);
    const completed = await screen.findByRole("button", {
      name: /Swift picker 1.*Completed/,
    });
    expect(completed.getAttribute("aria-expanded")).toBe("false");
    expect(messageCalls()).toHaveLength(1);

    fireEvent.click(completed);
    expect(screen.getByText("agent-1 activity")).toBeDefined();
    expect(await screen.findByText("agent-1 finished")).toBeDefined();
    expect(messageCalls()).toHaveLength(2);
  });

  test("does not reload other expanded transcripts when an agent opens or closes", async () => {
    agents = [agent(1), agent(2), agent(3)];
    render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Swift picker 1/ }),
    );
    expect(await screen.findByText("agent-1 activity")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Swift picker 2/ }));
    expect(await screen.findByText("agent-2 activity")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Swift picker 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /Swift picker 3/ }));
    expect(await screen.findByText("agent-3 activity")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Swift picker 3/ }));

    expect(screen.getByText("agent-1 activity")).toBeDefined();
    expect(
      messageCalls().map(
        ([, variables]) => (variables as { subagentId: string }).subagentId,
      ),
    ).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  test("fills a gap of more than one new page after reconnecting", async () => {
    agents = [agent(1)];
    const original = event("original message", "2026-11-04T16:13:23.000Z");
    pages["agent-1:latest"] = { events: [original], nextCursor: null };
    const { rerender } = render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Swift picker 1/ }),
    );
    expect(await screen.findByText("original message")).toBeDefined();
    pages["agent-1:latest"] = {
      events: Array.from({ length: 200 }, (_, index) =>
        event(`new message ${index}`, "2026-11-04T16:13:30.000Z", index),
      ),
      nextCursor: "gap-cursor",
    };
    pages["agent-1:gap-cursor"] = {
      events: [
        original,
        event("message in the gap", "2026-11-04T16:13:25.000Z"),
      ],
      nextCursor: null,
    };
    rerender(<RunAgentsCard refreshKey={1} runId="run-1" />);
    expect(await screen.findByText("message in the gap")).toBeDefined();
    expect(screen.getByText("new message 199")).toBeDefined();
    expect(screen.getAllByText("original message")).toHaveLength(1);
    expect(messageCalls().at(-1)?.[1]).toEqual({
      runId: "run-1",
      subagentId: "agent-1",
      before: "gap-cursor",
      first: 200,
    });
  });

  test("shows nested agent relationships and start times in collapsed rows", async () => {
    agents = [agent(1), agent(2, { parentNativeId: "native-1" })];
    render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    const child = await screen.findByRole("button", { name: /Swift picker 2/ });
    expect(within(child).getByText("Spawned by Swift picker 1")).toBeDefined();
    expect(within(child).getByText("11:13:23 AM")).toBeDefined();
    expect(child.getAttribute("aria-expanded")).toBe("false");
  });

  test("uses canonical sequence to order messages sharing a timestamp", async () => {
    agents = [agent(1)];
    pages["agent-1:latest"] = {
      events: [
        event("a-tool-result", undefined, 2),
        event("z-tool-call", undefined, 1),
      ],
      nextCursor: null,
    };
    render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Swift picker 1/ }),
    );
    expect(await screen.findByText("z-tool-call")).toBeDefined();
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Activity"),
      expect.stringContaining("z-tool-call"),
      expect.stringContaining("a-tool-result"),
    ]);
  });

  test("shows unavailable and partial sessions while preserving known prompts and results", async () => {
    agents = [
      agent(1, { transcriptStatus: "PARTIAL" }),
      agent(2, {
        transcriptStatus: "UNAVAILABLE",
        transcriptError: "Transcript file is missing",
      }),
    ];
    pages["agent-2:latest"] = { events: [], nextCursor: null };
    render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Swift picker 1/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Swift picker 2/ }));
    expect(
      await screen.findByText(
        "Only part of this agent's session is available.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("This agent's session transcript is unavailable."),
    ).toBeDefined();
    expect(screen.getByText("Transcript file is missing")).toBeDefined();
    expect(screen.getByText("Picked file 2.swift")).toBeDefined();
  });

  test("retries a failed transcript read without losing the agents list", async () => {
    render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    const first = await screen.findByRole("button", { name: /Swift picker 1/ });
    request.mockRejectedValueOnce(new Error("Transcript read failed"));
    fireEvent.click(first);
    expect(await screen.findByText("Transcript read failed")).toBeDefined();
    expect(
      screen.getAllByRole("button", { name: /Swift picker/ }),
    ).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("agent-1 activity")).toBeDefined();
    expect(screen.queryByText("Transcript read failed")).toBeNull();
  });

  test("aborts old run reads and ignores their late responses during navigation", async () => {
    let resolveOld!: (value: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    request.mockImplementationOnce((_query, _variables, options) => {
      oldSignal = options?.signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      }) as never;
    });
    const { rerender } = render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    await vi.waitFor(() => expect(resolveOld).toBeDefined());
    agents = [agent(9, { runId: "run-2" })];
    rerender(<RunAgentsCard refreshKey={0} runId="run-2" />);
    expect(
      await screen.findByRole("button", { name: /Swift picker 9/ }),
    ).toBeDefined();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      resolveOld({ runSubagents: [agent(1)] });
    });
    expect(screen.queryByRole("button", { name: /Swift picker 1/ })).toBeNull();
  });

  test("hides the section when the run has no subagents", async () => {
    agents = [];
    render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("run-agents-card")).toBeNull();
  });

  test("discards an old agent transcript response after run navigation", async () => {
    let resolveOld!: (value: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    const { rerender } = render(<RunAgentsCard refreshKey={0} runId="run-1" />);
    const first = await screen.findByRole("button", { name: /Swift picker 1/ });
    request.mockImplementationOnce((_query, _variables, options) => {
      oldSignal = options?.signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      }) as never;
    });
    fireEvent.click(first);
    await vi.waitFor(() => expect(resolveOld).toBeDefined());
    agents = [agent(9, { runId: "run-2" })];
    rerender(<RunAgentsCard refreshKey={0} runId="run-2" />);
    expect(
      await screen.findByRole("button", { name: /Swift picker 9/ }),
    ).toBeDefined();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      resolveOld({
        runSubagentMessages: {
          events: [event("old session message")],
          nextCursor: null,
        },
      });
    });
    expect(screen.queryByText("old session message")).toBeNull();
  });
});
