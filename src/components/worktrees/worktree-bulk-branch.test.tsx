import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { Worktree, WorktreeAgentGroup } from "./types";
import { WorktreeBulkBranch } from "./worktree-bulk-branch";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function worktree(id: string, changes: Partial<Worktree> = {}) {
  return {
    id,
    branch: `feature/${id}`,
    folder: `/repos/${id}`,
    relativePath: id,
    baseBranch: "develop",
    availability: "AVAILABLE",
    missingAt: null,
    ...changes,
  } as Worktree;
}

function agent(
  name: string,
  worktrees: Worktree[],
  remoteBranches = ["main", "develop", "release"],
): WorktreeAgentGroup {
  return {
    agent: {
      id: name,
      name,
      connectionStatus: "ONLINE",
      capabilities: ["worktree.branch"],
    },
    codebases: [
      {
        codebase: {
          id: `checkout-${name}`,
          folder: `/repo/${name}`,
          availability: "AVAILABLE",
          defaultBranch: "main",
          localBranches: worktrees.flatMap(({ branch }) => branch ?? []),
          remoteBranches,
        },
        repository: { id: "repo-1", name: "App" },
        worktrees,
      },
    ],
  } as WorktreeAgentGroup;
}

function completedBatch() {
  return {
    id: "batch-1",
    appId: "app-1",
    agentId: null,
    mode: "EXISTING",
    branchName: "release",
    ticketKey: null,
    status: "COMPLETED",
    createdAt: "2026-11-12T12:00:00.000Z",
    updatedAt: "2026-11-12T12:00:01.000Z",
    finishedAt: "2026-11-12T12:00:01.000Z",
    items: [
      {
        id: "item-1",
        worktreeId: "one",
        codebaseId: "checkout-Studio",
        repositoryName: "App",
        agentName: "Studio",
        folder: "/repos/one",
        sourceBranch: "feature/one",
        baseBranch: "develop",
        status: "SUCCEEDED",
        error: null,
        warning: null,
        jobId: "job-1",
      },
      {
        id: "item-2",
        worktreeId: "two",
        codebaseId: "checkout-Mini",
        repositoryName: "App",
        agentName: "Mini",
        folder: "/repos/two",
        sourceBranch: "feature/two",
        baseBranch: "main",
        status: "FAILED",
        error: "Git could not carry over local changes",
        warning: null,
        jobId: "job-2",
      },
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Element.prototype.scrollIntoView = vi.fn();
  request.mockImplementation(async (query) => {
    if (query.includes("mutation StartWorktreeBranchBatch"))
      return { startWorktreeBranchBatch: completedBatch() } as never;
    return { worktreeBranchBatches: [] } as never;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  request.mockReset();
  document.cookie = "worktree-branch-mode=; Max-Age=0; Path=/";
});

async function choose(ariaLabel: string, option: string | RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: ariaLabel }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

test("submits the chosen visible worktrees with their own bases and shows mixed outcomes", async () => {
  const first = worktree("one", { hasStagedChanges: true });
  const extra = worktree("extra");
  const second = worktree("two");
  const agents = [
    agent("Studio", [first, extra], ["main", "develop", "release", "busy"]),
    agent("Mini", [second], ["main", "release"]),
  ];
  const allAgents = [
    agent("Studio", [first, extra, worktree("hidden", { branch: "busy" })]),
    agents[1]!,
  ];
  const onReload = vi.fn().mockResolvedValue(undefined);
  render(
    <WorktreeBulkBranch
      agents={agents}
      allAgents={allAgents}
      agentId={null}
      appId="app-1"
      disabled={false}
      onReload={onReload}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Bulk Change Branch" }));
  fireEvent.click(screen.getByRole("tab", { name: "Existing branch" }));
  await choose("Existing branch", /^busy,/);
  expect(
    screen
      .getByRole("checkbox", { name: "Select feature/one" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("checkbox", { name: "Select busy" })).toBeNull();
  expect(
    screen.getAllByText(
      "Another worktree in this clone already uses the destination branch.",
    ),
  ).toHaveLength(2);

  await choose("Existing branch", /^release,/);
  const firstChoice = screen.getByRole("checkbox", {
    name: "Select feature/one",
  });
  expect(firstChoice.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(firstChoice);
  expect(
    screen
      .getByRole("checkbox", { name: "Select feature/extra" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select feature/two" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Change branch on 2 worktrees" }),
  );

  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("mutation StartWorktreeBranchBatch"),
    {
      input: {
        appId: "app-1",
        agentId: null,
        requestId: expect.any(String),
        mode: "EXISTING",
        branchName: "release",
        ticketKey: null,
        items: [
          {
            worktreeId: "one",
            expectedBranch: "feature/one",
            baseBranch: "develop",
          },
          {
            worktreeId: "two",
            expectedBranch: "feature/two",
            baseBranch: "main",
          },
        ],
      },
    },
  );
  await screen.findByRole("heading", { name: "Bulk Change Branch completed" });
  expect(screen.getByText("Branch changed")).toBeDefined();
  expect(
    screen.getByText("Git could not carry over local changes"),
  ).toBeDefined();
  expect(onReload).toHaveBeenCalledOnce();
});

test("uses the selected Jira checkout to resolve one destination and applies a shared base", async () => {
  const agents = [
    agent("Studio", [worktree("one")]),
    agent("Mini", [worktree("two")]),
  ];
  request.mockImplementation(async (query) => {
    if (query.includes("query WorktreeTicketBranchContext"))
      return {
        worktreeTicketBranchContext: {
          ticketKey: "APP-42",
          ticketTitle: "Improve search",
          projectKey: "APP",
          branchNamingMode: "JAVASCRIPT",
          branchName: "feature/APP-42-search",
        },
      } as never;
    if (query.includes("mutation StartWorktreeBranchBatch"))
      return { startWorktreeBranchBatch: completedBatch() } as never;
    return { worktreeBranchBatches: [] } as never;
  });
  render(
    <WorktreeBulkBranch
      agents={agents}
      allAgents={agents}
      agentId={null}
      disabled={false}
      onReload={vi.fn().mockResolvedValue(undefined)}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Bulk Change Branch" }));
  fireEvent.click(screen.getByRole("tab", { name: "From ticket" }));
  await choose("Naming checkout", /^App · Mini,/);
  await choose("Base branch (optional)", "main");
  fireEvent.change(screen.getByLabelText("Ticket key"), {
    target: { value: "app-42" },
  });
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select feature/one" }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select feature/two" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Change branch on 2 worktrees" }),
  );

  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("query WorktreeTicketBranchContext"),
    {
      input: {
        codebaseId: "checkout-Mini",
        worktreeId: "two",
        ticketKey: "APP-42",
      },
    },
  );
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining("mutation StartWorktreeBranchBatch"),
    {
      input: expect.objectContaining({
        mode: "TICKET",
        branchName: "feature/APP-42-search",
        ticketKey: "APP-42",
        items: [
          {
            worktreeId: "one",
            expectedBranch: "feature/one",
            baseBranch: "main",
          },
          {
            worktreeId: "two",
            expectedBranch: "feature/two",
            baseBranch: "main",
          },
        ],
      }),
    },
  );
  await screen.findByRole("heading", { name: "Bulk Change Branch completed" });
});

test("recovers active and latest completed results independently of visible worktrees", async () => {
  const completed = completedBatch();
  request.mockResolvedValue({
    worktreeBranchBatches: [
      {
        ...completed,
        id: "batch-active",
        status: "ACTIVE",
        branchName: "next",
      },
      completed,
      {
        ...completed,
        id: "batch-old",
        branchName: "old",
        createdAt: "2026-11-12T12:00:00.500Z",
        finishedAt: "2026-11-12T12:00:00.900Z",
      },
    ],
  } as never);
  render(
    <WorktreeBulkBranch
      agents={[]}
      allAgents={[]}
      agentId="Studio"
      appId="app-1"
      disabled={false}
      onReload={vi.fn().mockResolvedValue(undefined)}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Bulk Change Branch" }));
  await screen.findByRole("heading", { name: "Bulk Change Branch running" });
  expect(
    screen.getByRole("heading", { name: "Bulk Change Branch completed" }),
  ).toBeDefined();
  expect(screen.queryByText("old")).toBeNull();
  expect(screen.getByText("No worktrees match this view.")).toBeDefined();
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("query WorktreeBranchBatches"),
      { appId: "app-1", agentId: "Studio" },
      { signal: expect.anything() },
    ),
  );
});
