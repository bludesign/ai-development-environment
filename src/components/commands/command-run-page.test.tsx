import {
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
const push = vi.hoisted(() => vi.fn());

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
    loadAddon() {}
    open() {}
    write(value: string | Uint8Array, callback?: () => void) {
      terminalWrite(value);
      callback?.();
    }
    onScroll() {
      return { dispose: vi.fn() };
    }
    scrollToBottom() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const timestamp = "2026-07-25T12:00:00.000Z";
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
  agentName: "Studio",
  agentHostname: "studio.local",
  worktreeId: null,
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
  push.mockReset();
  subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
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
  });

  test("navigates to the successor returned by rerun", async () => {
    render(<CommandRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rerun" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/commands/runs/run-2"),
    );
  });
});
