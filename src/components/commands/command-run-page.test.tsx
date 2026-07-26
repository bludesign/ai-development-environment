import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { CommandRunPage } from "./command-run-page";

const terminalWrite = vi.hoisted(() => vi.fn());
const terminalReset = vi.hoisted(() => vi.fn());
const terminalOptions = vi.hoisted(() => vi.fn());
const terminalOnScroll = vi.hoisted(() => vi.fn());
const terminalScrollToBottom = vi.hoisted(() => vi.fn());
const terminalSearchNext = vi.hoisted(() => vi.fn());
const terminalSearchPrevious = vi.hoisted(() => vi.fn());
const terminalSearchClear = vi.hoisted(() => vi.fn());
const terminalSearchResults = vi.hoisted(() => vi.fn());
const terminalBuffers = vi.hoisted(
  () => [] as Array<{ active: { viewportY: number; baseY: number } }>,
);
const push = vi.hoisted(() => vi.fn());
const writeText = vi.hoisted(() => vi.fn());

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    buffer = { active: { viewportY: 0, baseY: 0 } };
    constructor(options: unknown) {
      terminalOptions(options);
      terminalBuffers.push(this.buffer);
    }
    loadAddon() {}
    open() {}
    write(value: string | Uint8Array, callback?: () => void) {
      terminalWrite(value);
      callback?.();
    }
    onScroll(callback: () => void) {
      terminalOnScroll(callback);
      return { dispose: vi.fn() };
    }
    scrollToBottom() {
      terminalScrollToBottom();
    }
    reset() {
      terminalReset();
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext(term: string, options: unknown) {
      terminalSearchNext(term, options);
      return true;
    }
    findPrevious(term: string, options: unknown) {
      terminalSearchPrevious(term, options);
      return true;
    }
    clearDecorations() {
      terminalSearchClear();
    }
    onDidChangeResults(callback: unknown) {
      terminalSearchResults(callback);
      return { dispose: vi.fn() };
    }
  },
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const timestamp = "2026-07-25T12:00:00.000Z";
let nextOutput: ((chunk: Record<string, unknown>) => void) | null = null;
const run = {
  id: "run-1",
  displayNumber: 42,
  commandId: "command-1",
  command: { id: "command-1", name: "Color output" },
  origin: "MANUAL",
  status: "SUCCEEDED",
  snapshotName: "Color output",
  snapshotDescription: "",
  snapshotScript: "printf color",
  snapshotTargetKind: "ANY_AGENT_HOME",
  snapshotRestartPolicy: "NEVER",
  snapshotRestartLimit: 3,
  snapshot: { id: "command-1", name: "Color output" },
  agentId: "agent-1",
  agent: null,
  agentName: "Studio",
  agentHostname: "studio.local",
  worktreeId: null,
  worktree: null,
  worktreePath: null,
  worktreeBranch: null,
  restartCount: 0,
  stopRequested: false,
  nextRestartAt: null,
  predecessorRunId: null,
  predecessor: null,
  successor: null,
  error: null,
  exitCode: 0,
  signal: null,
  attempts: [],
  queuedAt: timestamp,
  startedAt: timestamp,
  finishedAt: timestamp,
  archivedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  terminalWrite.mockReset();
  terminalReset.mockReset();
  terminalOptions.mockReset();
  terminalOnScroll.mockReset();
  terminalScrollToBottom.mockReset();
  terminalSearchNext.mockReset();
  terminalSearchPrevious.mockReset();
  terminalSearchClear.mockReset();
  terminalSearchResults.mockReset();
  terminalBuffers.splice(0);
  push.mockReset();
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  nextOutput = null;
  subscriptions.mockReturnValue({
    subscribe: vi.fn((operation, sink) => {
      if (String(operation.query).includes("subscription CommandOutput")) {
        nextOutput = (chunk) =>
          sink.next({ data: { commandRunOutputAdded: chunk } } as never);
      }
      return vi.fn();
    }),
  } as never);
  request.mockImplementation(async (query) => {
    if (query.includes("CommandRunDetail")) return { commandRun: run } as never;
    if (query.includes("CommandOutput")) {
      return {
        commandRunOutput: [
          {
            id: "chunk-1",
            attemptId: "attempt-1",
            attemptNumber: 1,
            sequence: 0,
            stream: "STDOUT",
            dataBase64: Buffer.from([
              0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xf0, 0x9f,
            ]).toString("base64"),
            byteLength: 7,
            createdAt: timestamp,
          },
          {
            id: "chunk-2",
            attemptId: "attempt-1",
            attemptNumber: 1,
            sequence: 1,
            stream: "STDOUT",
            dataBase64: Buffer.from([
              0x99, 0x82, 0x1b, 0x5b, 0x30, 0x6d,
            ]).toString("base64"),
            byteLength: 6,
            createdAt: timestamp,
          },
        ],
      } as never;
    }
    if (query.includes("RerunCommandRun")) {
      return { rerunCommandRun: { id: "run-2" } } as never;
    }
    throw new Error(`Unexpected request: ${query}`);
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
  vi.unstubAllGlobals();
});

describe("CommandRunPage", () => {
  test("does not offer definition editing for a custom command run", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("CommandRunDetail")) {
        return {
          commandRun: {
            ...run,
            commandId: null,
            command: null,
            snapshotName: "Custom command",
          },
        } as never;
      }
      if (query.includes("CommandOutput")) {
        return { commandRunOutput: [] } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<CommandRunPage runId="run-1" />);
    expect(await screen.findByText("Custom command")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Edit command" })).toBeNull();
    expect(screen.getByRole("button", { name: "Rerun" })).toBeDefined();
  });

  test("initializes output after a delayed run load mounts the terminal", async () => {
    let resolveRun: (value: { commandRun: typeof run }) => void = () =>
      undefined;
    const runDetail = new Promise<{ commandRun: typeof run }>((resolve) => {
      resolveRun = resolve;
    });
    request.mockImplementation(async (query) => {
      if (query.includes("CommandRunDetail")) return runDetail as never;
      if (query.includes("CommandOutput")) {
        return {
          commandRunOutput: [
            {
              id: "delayed-chunk",
              attemptId: "attempt-1",
              attemptNumber: 1,
              sequence: 0,
              stream: "STDOUT",
              dataBase64: Buffer.from("delayed output\n").toString("base64"),
              byteLength: 15,
              createdAt: timestamp,
            },
          ],
        } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<CommandRunPage runId="run-1" />);
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("CommandRunDetail"),
        ),
      ).toBe(true),
    );
    expect(terminalOptions).not.toHaveBeenCalled();

    resolveRun({ commandRun: run });

    expect(await screen.findByText("Color output")).toBeDefined();
    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.some(
          ([value]) =>
            value instanceof Uint8Array &&
            Buffer.from(value).toString("utf8") === "delayed output\n",
        ),
      ).toBe(true),
    );
  });

  test("writes ordered raw ANSI and split UTF-8 bytes to xterm", async () => {
    render(<CommandRunPage runId="run-1" />);
    expect(await screen.findByText("Color output")).toBeDefined();

    await waitFor(() => {
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) => value instanceof Uint8Array,
        ),
      ).toHaveLength(2);
    });
    const bytes = Buffer.concat(
      terminalWrite.mock.calls
        .map(([value]) => value)
        .filter((value): value is Uint8Array => value instanceof Uint8Array)
        .map((value) => Buffer.from(value)),
    );
    expect(bytes.toString("utf8")).toBe("\u001b[31m🙂\u001b[0m");
    expect(terminalOptions).toHaveBeenCalledWith(
      expect.objectContaining({ allowProposedApi: true, convertEol: true }),
    );
  });

  test("appends late output chunks without resetting visible output", async () => {
    render(<CommandRunPage runId="run-1" />);
    expect(await screen.findByText("Color output")).toBeDefined();
    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) => value instanceof Uint8Array,
        ),
      ).toHaveLength(2),
    );
    await waitFor(() => expect(nextOutput).not.toBeNull());

    nextOutput?.({
      id: "late-chunk",
      attemptId: "attempt-1",
      attemptNumber: 1,
      sequence: -1,
      stream: "STDOUT",
      dataBase64: Buffer.from("late output\n").toString("base64"),
      byteLength: 12,
      createdAt: timestamp,
    });

    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) => value instanceof Uint8Array,
        ),
      ).toHaveLength(3),
    );
    expect(terminalReset).not.toHaveBeenCalled();
  });

  test("offers follow output after the terminal is scrolled away from the bottom", async () => {
    render(<CommandRunPage runId="run-1" />);
    expect(await screen.findByText("Color output")).toBeDefined();
    await waitFor(() => expect(terminalOnScroll).toHaveBeenCalled());

    const buffer = terminalBuffers.at(-1);
    expect(buffer).toBeDefined();
    buffer!.active.baseY = 10;
    buffer!.active.viewportY = 5;
    terminalOnScroll.mock.calls.at(-1)?.[0]();

    const followButton = await screen.findByRole("button", {
      name: "Follow output",
    });
    expect(screen.getByRole("log").parentElement?.contains(followButton)).toBe(
      true,
    );
    expect(followButton.className).toContain("absolute");
    expect(followButton.className).toContain("bg-neutral-800/70");
    fireEvent.click(followButton);
    expect(terminalScrollToBottom).toHaveBeenCalled();
  });

  test("searches terminal output and navigates between matches", async () => {
    render(<CommandRunPage runId="run-1" />);
    expect(await screen.findByText("Color output")).toBeDefined();
    await waitFor(() => expect(terminalSearchResults).toHaveBeenCalled());
    const search = screen.getByRole("searchbox", {
      name: "Search terminal",
    });

    fireEvent.change(search, { target: { value: "color" } });
    expect(terminalSearchNext).toHaveBeenCalledWith(
      "color",
      expect.objectContaining({
        incremental: true,
        decorations: expect.any(Object),
      }),
    );
    act(() =>
      terminalSearchResults.mock.calls.at(-1)?.[0]({
        resultIndex: 0,
        resultCount: 2,
      }),
    );
    expect(screen.getByText("1/2")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(terminalSearchPrevious).toHaveBeenCalledWith(
      "color",
      expect.any(Object),
    );
    fireEvent.keyDown(search, { key: "Enter" });
    expect(terminalSearchNext).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(terminalSearchClear).toHaveBeenCalled();
  });

  test("replays persisted output when the terminal lifecycle is replaced", async () => {
    const { rerender } = render(<CommandRunPage runId="run-1" />);
    expect(await screen.findByText("Color output")).toBeDefined();

    await waitFor(() => {
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) => value instanceof Uint8Array,
        ),
      ).toHaveLength(2);
    });

    rerender(<CommandRunPage runId="run-2" />);

    await waitFor(() => {
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) => value instanceof Uint8Array,
        ),
      ).toHaveLength(4);
    });
  });

  test("navigates to the successor returned by rerun", async () => {
    render(<CommandRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rerun" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/commands/runs/run-2"),
    );
  });

  test("links to the command editor from the page actions", async () => {
    render(<CommandRunPage runId="run-1" />);

    const editLink = await screen.findByRole("link", {
      name: "Edit command",
    });
    expect(editLink.getAttribute("href")).toBe("/commands/command-1/edit");
  });

  test("does not show a restart count when restarts are disabled", async () => {
    render(<CommandRunPage runId="run-1" />);

    expect(await screen.findByText("Never")).toBeDefined();
    expect(screen.queryByText(/0\/3/)).toBeNull();
  });

  test("shows one overview card with the start date and duration", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("CommandRunDetail")) {
        return {
          commandRun: {
            ...run,
            agentName: "An-agent-name-that-is-long-enough-to-need-wrapping",
            agentHostname:
              "an-agent-hostname-that-is-long-enough-to-need-wrapping.local",
            worktreeId: "worktree-1",
            worktreeBranch:
              "feature/a-very-long-worktree-branch-that-needs-to-wrap",
            startedAt: "2026-07-25T12:00:00.000Z",
            finishedAt: "2026-07-25T12:01:05.000Z",
          },
        } as never;
      }
      if (query.includes("CommandOutput")) {
        return { commandRunOutput: [] } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<CommandRunPage runId="run-1" />);

    const overviewTitle = await screen.findByText("Overview");
    const overviewCard = overviewTitle.closest('[data-slot="card"]');
    expect(overviewCard).not.toBeNull();
    const detailList = overviewCard?.querySelector("dl");
    expect(detailList?.className).toContain("sm:grid-cols-6");
    expect(detailList?.querySelectorAll(".sm\\:col-span-3")).toHaveLength(2);
    expect(detailList?.querySelectorAll(".sm\\:col-span-2")).toHaveLength(3);
    const agentLink = overviewCard?.querySelector('a[href="/agents/agent-1"]');
    expect(agentLink?.className).toContain("whitespace-normal");
    expect(agentLink?.querySelector("span")?.className).toContain(
      "break-words",
    );
    const worktreeLink = overviewCard?.querySelector(
      'a[href="/worktrees/worktree-1"]',
    );
    expect(worktreeLink?.className).toContain("whitespace-normal");
    expect(worktreeLink?.querySelector("span")?.className).toContain(
      "break-words",
    );
    expect(
      overviewCard?.querySelector('time[dateTime="2026-07-25T12:00:00.000Z"]'),
    ).not.toBeNull();
    expect(overviewCard?.textContent).toContain("1m 5s");
    expect(overviewCard?.textContent).not.toContain("Finished");
  });

  test("highlights the header with the worktree color", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("CommandRunDetail")) {
        return {
          commandRun: {
            ...run,
            worktreeId: "worktree-1",
            worktree: {
              id: "worktree-1",
              folder: "/workspaces/example",
              branch: "feature/highlight",
              highlightColor: "blue",
            },
          },
        } as never;
      }
      if (query.includes("CommandOutput")) {
        return { commandRunOutput: [] } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<CommandRunPage runId="run-1" />);

    const summary = await screen.findByTestId("command-run-summary");
    expect(summary.className).toContain("rounded-lg");
    expect(summary.className).toContain("border-l-4");
    expect(summary.className).toContain("bg-blue-500/10");
    expect(summary.className).toContain("border-l-blue-500");
  });

  test("uses the standard cancel icon without decorating terminal output", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("CommandRunDetail")) {
        return {
          commandRun: { ...run, status: "RUNNING", finishedAt: null },
        } as never;
      }
      if (query.includes("CommandOutput")) {
        return { commandRunOutput: [] } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<CommandRunPage runId="run-1" />);

    const terminateButton = await screen.findByRole("button", {
      name: "Terminate",
    });
    expect(terminateButton.querySelector(".lucide-circle-stop")).not.toBeNull();
    const terminalTitle = screen.getByText("Terminal output");
    expect(terminalTitle.querySelector("svg")).toBeNull();
  });

  test("uses a standard table card for attempts and copies the command snapshot", async () => {
    render(<CommandRunPage runId="run-1" />);

    const attemptsTitle = await screen.findByText("Attempts");
    const attemptsCard = attemptsTitle.closest('[data-slot="card"]');
    expect(attemptsCard?.className).toContain("gap-0");
    expect(attemptsCard?.className).toContain("py-0");
    expect(attemptsCard?.querySelector("table")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("printf color"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
  });
});
