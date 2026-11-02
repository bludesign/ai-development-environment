import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import type { Worktree, WorktreeOverview, WorktreeSyncBatch } from "./types";
import { WorktreeBulkSync, worktreeSyncCandidates } from "./worktree-bulk-sync";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);

function worktree(id: string, changes: Partial<Worktree> = {}): Worktree {
  return {
    id,
    codebaseId: "codebase-1",
    branch: `feature/${id}`,
    baseBranch: "main",
    baseBehind: 2,
    upstream: `origin/feature/${id}`,
    folder: `/repos/${id}`,
    relativePath: id,
    availability: "AVAILABLE",
    missingAt: null,
    activeJob: null,
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasConflicts: false,
    rebaseInProgress: false,
    ticketKey: "AIDE-24",
    ticketTitle: "Review work",
    ...changes,
  } as Worktree;
}

function overview(
  worktrees = [worktree("one"), worktree("two")],
): WorktreeOverview {
  return {
    activeSyncBatches: [],
    agents: [
      {
        agent: {
          id: "agent-1",
          name: "Studio",
          connectionStatus: "ONLINE",
          capabilities: ["worktree.auto-sync"],
        },
        codebases: [
          {
            repository: { id: "repo-1", name: "Apollo" },
            codebase: { id: "codebase-1", availability: "AVAILABLE" },
            worktrees,
            blockingJob: null,
          },
        ],
      },
    ],
  } as unknown as WorktreeOverview;
}

function batch(
  status: WorktreeSyncBatch["status"] = "ACTIVE",
): WorktreeSyncBatch {
  return {
    id: "batch-1",
    status,
    appId: "app-1",
    agentId: "agent-1",
    createdAt: "2026-11-02T12:00:00Z",
    updatedAt: "2026-11-02T12:00:01Z",
    finishedAt: status === "COMPLETED" ? "2026-11-02T12:00:01Z" : null,
    items: [
      {
        id: "item-1",
        worktreeId: "one",
        codebaseId: "codebase-1",
        agentId: "agent-1",
        agentName: "Studio",
        repositoryId: "repo-1",
        repositoryName: "Apollo",
        branch: "feature/one",
        baseBranch: "main",
        folder: "/repos/one",
        ticketKey: "AIDE-24",
        ticketTitle: "Review work",
        baseBehind: 2,
        status: status === "COMPLETED" ? "SUCCEEDED" : "RUNNING",
        jobId: "job-1",
        error: null,
        createdAt: "2026-11-02T12:00:00Z",
        startedAt: "2026-11-02T12:00:00Z",
        finishedAt: null,
      },
    ],
  };
}

beforeEach(() => {
  request.mockReset();
  vi.mocked(onControlPlaneRecovery).mockClear();
});
afterEach(cleanup);

describe("Bulk Sync candidates", () => {
  test("selects known base-behind worktrees across the overview, respecting global agent focus", () => {
    const value = overview([
      worktree("one"),
      worktree("current", { baseBehind: 0 }),
      worktree("unknown", { baseBehind: null }),
    ]);
    value.agents.push({
      ...value.agents[0]!,
      agent: { ...value.agents[0]!.agent, id: "agent-2" },
      codebases: [
        { ...value.agents[0]!.codebases[0]!, worktrees: [worktree("other")] },
      ],
    });
    expect(
      worktreeSyncCandidates(value, null).map(({ worktree }) => worktree.id),
    ).toEqual(["one", "other"]);
    expect(
      worktreeSyncCandidates(value, "agent-1").map(
        ({ worktree }) => worktree.id,
      ),
    ).toEqual(["one"]);
    expect(worktreeSyncCandidates(value, "missing")).toEqual([]);
  });

  test.each([
    [{ missingAt: "2026-11-02T12:00:00Z" }, "unavailable"],
    [{ availability: "MISSING" }, "unavailable"],
    [{ hasStagedChanges: true }, "dirty"],
    [{ hasUnstagedChanges: true }, "dirty"],
    [{ hasConflicts: true }, "conflicts"],
    [{ rebaseInProgress: true }, "conflicts"],
    [{ branch: null }, "missingBranch"],
    [{ upstream: null }, "missingUpstream"],
    [{ baseBranch: null }, "missingBase"],
  ] as const)(
    "retains blocked worktrees with a reason: %s",
    (changes, reason) => {
      expect(
        worktreeSyncCandidates(overview([worktree("one", changes)]), null)[0]
          ?.blockedReason,
      ).toBe(reason);
    },
  );

  test("blocks offline, unsupported, busy and already queued rows", () => {
    const value = overview([worktree("one")]);
    value.agents[0]!.agent.connectionStatus = "OFFLINE";
    expect(worktreeSyncCandidates(value, null)[0]?.blockedReason).toBe(
      "offline",
    );
    value.agents[0]!.agent.connectionStatus = "ONLINE";
    value.agents[0]!.agent.capabilities = [];
    expect(worktreeSyncCandidates(value, null)[0]?.blockedReason).toBe(
      "unsupported",
    );
    value.agents[0]!.agent.capabilities = ["worktree.auto-sync"];
    value.agents[0]!.codebases[0]!.blockingJob = { id: "busy" } as never;
    expect(worktreeSyncCandidates(value, null)[0]?.blockedReason).toBe("busy");
    expect(
      worktreeSyncCandidates(value, null, [batch()])[0]?.blockedReason,
    ).toBe("activeSync");
    value.agents[0]!.codebases[0]!.codebase.availability = "MISSING";
    expect(worktreeSyncCandidates(value, null)[0]?.blockedReason).toBe(
      "unavailable",
    );
  });
});

test("prechecks eligible rows, shows general information, and submits only the included worktrees", async () => {
  request.mockImplementation(async (query) =>
    query.includes("mutation Start")
      ? ({ startWorktreeSyncBatch: batch() } as never)
      : ({ worktreeSyncBatch: batch() } as never),
  );
  const reload = vi.fn(async () => undefined);
  render(
    <WorktreeBulkSync
      overview={overview([
        worktree("one"),
        worktree("two"),
        worktree("dirty", { hasUnstagedChanges: true }),
      ])}
      appId="app-1"
      agentId="agent-1"
      disabled={false}
      onReload={reload}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Bulk Sync" }));
  const selection = screen.getByRole("region", {
    name: "Out-of-date worktrees",
  });
  expect(
    within(selection)
      .getByRole("checkbox", { name: "Select feature/one" })
      .getAttribute("data-state"),
  ).toBe("checked");
  expect(
    (
      within(selection).getByRole("checkbox", {
        name: "Select feature/dirty",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    within(selection).getByText("Stash or commit changes before syncing."),
  ).toBeDefined();
  expect(within(selection).getByText("/repos/one")).toBeDefined();
  expect(within(selection).getAllByText("Apollo · Studio")).toHaveLength(3);
  expect(within(selection).getAllByText("AIDE-24 · Review work")).toHaveLength(
    3,
  );
  fireEvent.click(
    within(selection).getByRole("checkbox", { name: "Select feature/two" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Sync selected (1)" }));
  await screen.findByText("Bulk Sync running");
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("mutation StartWorktreeSyncBatch"),
    {
      input: {
        worktreeIds: ["one"],
        requestId: expect.any(String),
        appId: "app-1",
        agentId: "agent-1",
      },
    },
  );
  expect(
    screen.getByRole("link", { name: "View job logs" }).getAttribute("href"),
  ).toBe("/dashboard/jobs/job-1");
  expect(
    screen.getByRole("link", { name: "feature/one" }).getAttribute("href"),
  ).toBe("/dashboard/worktrees/one");
  fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(reload).toHaveBeenCalled();
});

test("discovers an accepted batch after navigation and polls it to a terminal result", async () => {
  const value = overview();
  value.activeSyncBatches = [batch()];
  const terminal = batch("COMPLETED");
  terminal.items[0]!.status = "ATTENTION_REQUIRED";
  terminal.items[0]!.error = "Resolve the rebase conflicts";
  request.mockResolvedValue({ worktreeSyncBatch: terminal } as never);
  const reload = vi.fn(async () => undefined);
  render(
    <WorktreeBulkSync
      overview={value}
      appId="app-1"
      agentId="agent-1"
      disabled={false}
      onReload={reload}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Bulk Sync" }));
  await screen.findByText("Needs attention");
  expect(screen.getByText("Resolve the rebase conflicts")).toBeDefined();
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1");
  expect(reload).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("query WorktreeSyncBatch"),
    { id: "batch-1" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("leaving the page stops only monitoring and remounting rediscovers server work", async () => {
  const value = overview();
  value.activeSyncBatches = [batch()];
  request.mockResolvedValue({ worktreeSyncBatch: batch() } as never);
  const reload = vi.fn(async () => undefined);
  const first = render(
    <WorktreeBulkSync
      overview={value}
      appId="app-1"
      agentId="agent-1"
      disabled={false}
      onReload={reload}
    />,
  );
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  const signal = request.mock.calls[0]?.[2]?.signal;
  first.unmount();
  expect(signal?.aborted).toBe(true);
  expect(request.mock.calls.some(([query]) => /cancel/i.test(query))).toBe(
    false,
  );
  render(
    <WorktreeBulkSync
      overview={value}
      appId="app-1"
      agentId="agent-1"
      disabled={false}
      onReload={reload}
    />,
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
});

test("recovers batches from other originating views and limits rows by app repositories and global agent", async () => {
  const value = overview();
  const otherOrigin = batch();
  otherOrigin.appId = "other-app";
  otherOrigin.items.push(
    {
      ...otherOrigin.items[0]!,
      id: "other-repo-item",
      worktreeId: "other-repo",
      branch: "feature/other-repo",
      repositoryId: "repo-2",
    },
    {
      ...otherOrigin.items[0]!,
      id: "other-agent-item",
      worktreeId: "other-agent",
      branch: "feature/other-agent",
      agentId: "agent-2",
    },
  );
  request.mockResolvedValue({
    worktreeSyncBatch: {
      ...otherOrigin,
      status: "COMPLETED",
      updatedAt: "2026-11-02T12:00:02Z",
      items: otherOrigin.items.map((item) => ({
        ...item,
        status: "SUCCEEDED",
      })),
    },
  } as never);
  value.activeSyncBatches = [otherOrigin];
  const reload = vi.fn(async () => undefined);
  const view = render(
    <WorktreeBulkSync
      overview={value}
      agentId={null}
      disabled={false}
      onReload={reload}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Bulk Sync" }));
  expect(
    screen.getByRole("link", { name: "feature/other-repo" }),
  ).toBeDefined();
  expect(
    screen.getByRole("link", { name: "feature/other-agent" }),
  ).toBeDefined();
  view.rerender(
    <WorktreeBulkSync
      overview={value}
      appId="app-1"
      agentId="agent-1"
      disabled={false}
      onReload={reload}
    />,
  );
  await screen.findByText("Bulk Sync completed");
  expect(screen.getByRole("link", { name: "feature/one" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "feature/other-repo" })).toBeNull();
  expect(
    screen.queryByRole("link", { name: "feature/other-agent" }),
  ).toBeNull();
});

test("recovers app batch outcomes after its last checkout has been removed", async () => {
  const value = overview([]);
  value.agents = [];
  value.activeSyncBatches = [batch()];
  request.mockResolvedValue({ worktreeSyncBatch: batch("COMPLETED") } as never);
  render(
    <WorktreeBulkSync
      overview={value}
      appId="app-1"
      agentId={null}
      scopeRepositoryIds={["repo-1"]}
      disabled
      onReload={vi.fn(async () => undefined)}
    />,
  );
  const button = screen.getByRole("button", { name: "Bulk Sync" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByText("Bulk Sync completed");
  expect(screen.getByRole("link", { name: "feature/one" })).toBeDefined();
  expect(
    screen.getByText("No out-of-date worktrees in this scope."),
  ).toBeDefined();
});

test("retries an uncertain submission with the same request ID", async () => {
  request.mockRejectedValue(new Error("Connection lost"));
  render(
    <WorktreeBulkSync
      overview={overview([worktree("one")])}
      agentId={null}
      disabled={false}
      onReload={vi.fn(async () => undefined)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Bulk Sync" }));
  fireEvent.click(screen.getByRole("button", { name: "Sync selected (1)" }));
  await screen.findByText("Connection lost");
  const first = request.mock.calls[0]?.[1];
  fireEvent.click(screen.getByRole("button", { name: "Sync selected (1)" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]?.[1]).toEqual(first);
});

test("shows monitoring errors while preserving results and recovers on reconnect", async () => {
  const value = overview();
  value.activeSyncBatches = [batch()];
  request.mockRejectedValueOnce(new Error("Read failed"));
  request.mockResolvedValue({ worktreeSyncBatch: batch("COMPLETED") } as never);
  render(
    <WorktreeBulkSync
      overview={value}
      appId="app-1"
      agentId="agent-1"
      disabled={false}
      onReload={vi.fn(async () => undefined)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Bulk Sync" }));
  await screen.findByText(/Read failed/);
  expect(screen.getByText("Bulk Sync running")).toBeDefined();
  await act(async () => {
    vi.mocked(onControlPlaneRecovery).mock.calls[0]?.[0]({
      initialConnection: false,
    } as never);
  });
  await screen.findByText("Bulk Sync completed");
  expect(screen.queryByText(/Read failed/)).toBeNull();
});
