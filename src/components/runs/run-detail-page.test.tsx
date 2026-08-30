import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { RunDetailPage } from "./run-detail-page";
import type { AgentRunView } from "./types";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

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
  useRouter: () => ({ push }),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const failedRun: AgentRunView = {
  id: "run-353",
  kind: "SESSION",
  displayNumber: 353,
  status: "FAILED",
  phase: "FAILED",
  origin: "MANAGED",
  provider: "CODEX",
  providerVersion: null,
  worktreeId: "worktree-1",
  agentId: "agent-1",
  worktree: {
    id: "worktree-1",
    folder: "/workspace/ai-development-environment",
    branch: "feature/AIDE-66-plans-and-sessions-support",
    highlightColor: null,
  },
  jiraIssueKey: "AIDE-66",
  repositoryName: "ai-development-environment",
  branch: "feature/AIDE-66-plans-and-sessions-support",
  model: "gpt-5.6",
  effort: null,
  webSearchEnabled: false,
  initialPrompt: "Implement plans and sessions support",
  finalOutput: null,
  error: "Control agent restarted while this run was active",
  estimatedCost: null,
  pricingSource: null,
  pricingUpdatedAt: null,
  catalogCost: null,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCallCount: 0,
  sourcePlanId: null,
  sourcePlanNumber: null,
  playedAt: null,
  playedSessionNumber: null,
  sourcePlan: null,
  playedSession: null,
  parentRunId: null,
  parentRunNumber: null,
  parentRun: null,
  followUps: [],
  attempts: [],
  inputs: [],
  modelUsage: [],
  toolCalls: [],
  questionBatches: [],
  checkpoints: [],
  archivedAt: null,
  nativeArchivedAt: null,
  startedAt: "2026-07-23T12:42:45.000Z",
  finishedAt: "2026-07-23T12:43:00.000Z",
  createdAt: "2026-07-23T12:42:45.000Z",
  updatedAt: "2026-07-23T12:43:00.000Z",
};
let runData = failedRun;
let worktreeOverviewData: unknown = {
  agents: [],
  tags: [],
  settings: {},
  hiddenCount: 0,
  activeMoves: [],
};
let eventData: Array<{
  id: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  type: string;
  summary: string;
  detailMarkdown: string | null;
  raw: unknown;
  createdAt: string;
  supersededAt: string | null;
}> = [];

describe("RunDetailPage", () => {
  beforeEach(() => {
    runData = failedRun;
    worktreeOverviewData = {
      agents: [],
      tags: [],
      settings: {},
      hiddenCount: 0,
      activeMoves: [],
    };
    eventData = [];
    push.mockReset();
    request.mockReset();
    subscriptions.mockReset();
    subscriptions.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    request.mockImplementation(async (query, variables) => {
      const operation = String(query);
      if (operation.includes("query AgentRunDetail")) {
        return {
          agentRun: runData,
          runProviderCatalog: [
            {
              key: "CODEX",
              label: "Codex",
              available: true,
              supportsWebSearch: true,
              supportsPause: true,
              supportsSteering: true,
              supportsResume: true,
              supportsNativeDelete: true,
              models: [{ id: "gpt-5.6", label: "GPT-5.6", efforts: [] }],
            },
          ],
        } as never;
      }
      if (operation.includes("query RunActivity")) {
        const afterSequence = Number(
          (variables as { afterSequence?: number } | undefined)
            ?.afterSequence ?? -1,
        );
        return {
          runEvents: eventData
            .filter(({ sequence }) => sequence > afterSequence)
            .slice(0, 500),
        } as never;
      }
      if (operation.includes("query WorktreeDetailOverview")) {
        return {
          worktreeOverview: worktreeOverviewData,
          builds: { items: [], nextCursor: null },
          worktreeCoverageReports: [],
          worktreeRunQueue: [],
        } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the persisted error for a failed session", async () => {
    render(<RunDetailPage runId="run-353" />);

    expect(
      await screen.findByText(
        "Control agent restarted while this run was active",
      ),
    ).toBeDefined();
  });

  test("places worktree Actions, Status, and Builds after Follow Up", async () => {
    worktreeOverviewData = {
      hiddenCount: 0,
      tags: [],
      activeMoves: [],
      settings: {
        editorVariant: "CODE",
        updatedAt: "2026-07-23T12:00:00.000Z",
      },
      agents: [
        {
          agent: {
            id: "agent-1",
            name: "Mac Studio",
            hostname: "studio.local",
            connectionStatus: "ONLINE",
            capabilities: ["ios.build.run", "command.run"],
            baseRepoDirectory: "/workspace",
          },
          codebases: [
            {
              iosBuildConfigured: true,
              blockingJob: null,
              quickActions: [],
              mergeConflictQuickActions: [],
              repository: {
                id: "repo-1",
                name: "aide",
                displayOrigin: "github.com/example/aide",
              },
              codebase: {
                id: "codebase-1",
                folder: "/workspace/aide",
                defaultBranch: "main",
              },
              worktrees: [
                {
                  id: "worktree-1",
                  codebaseId: "codebase-1",
                  folder: "/workspace/ai-development-environment",
                  branch: "feature/AIDE-66-plans-and-sessions-support",
                  headSha: "abcdef1234567890",
                  upstream: "origin/feature/AIDE-66-plans-and-sessions-support",
                  ahead: 0,
                  behind: 0,
                  syncState: "IN_SYNC",
                  baseBranch: "main",
                  baseBranchOverride: null,
                  baseAhead: 1,
                  baseBehind: 0,
                  hasStagedChanges: false,
                  hasUnstagedChanges: false,
                  rebaseInProgress: false,
                  availability: "AVAILABLE",
                  pullRequest: null,
                  sourceControlRequest: null,
                  gitLabPipelines: [],
                  latestBuild: null,
                },
              ],
            },
          ],
        },
      ],
    };
    runData = {
      ...failedRun,
      checkpoints: [
        {
          id: "checkpoint-1",
          kind: "FINAL",
          headSha: "abcdef1234567890",
          branch: failedRun.branch,
          upstreamSha: null,
          indexTree: null,
          worktreeTree: null,
          refName: null,
          diffSummary: null,
          diffPatch: null,
          stashRef: null,
          createdAt: "2026-07-23T12:43:00.000Z",
        },
      ],
    };

    render(<RunDetailPage runId="run-353" />);

    expect(await screen.findByText("Worktree Status")).toBeDefined();
    const titles = Array.from(
      document.querySelectorAll('[data-slot="card-title"]'),
      (node) => node.textContent,
    );
    const ordered = [
      "Follow Up",
      "Actions",
      "Worktree Status",
      "Builds",
      "Changes",
    ];
    expect(ordered.map((title) => titles.indexOf(title))).toEqual(
      [...ordered.map((title) => titles.indexOf(title))].sort((a, b) => a - b),
    );
    expect(
      screen.getByRole("link", { name: "Open Worktree" }).getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(screen.getByRole("button", { name: "Build" })).toBeDefined();
    expect(screen.getByRole("link", { name: "New plan" })).toBeDefined();
    expect(screen.getByRole("link", { name: "New session" })).toBeDefined();
  });

  test("omits worktree cards when the run has no worktree", async () => {
    runData = { ...failedRun, worktreeId: null, worktree: null };

    render(<RunDetailPage runId="run-353" />);

    expect(await screen.findByText("Follow Up")).toBeDefined();
    expect(screen.queryByText("Worktree Status")).toBeNull();
  });

  test("formats answers and keeps prompt, result, activity, and changes controls compact", async () => {
    runData = {
      ...failedRun,
      status: "COMPLETED",
      phase: "COMPLETED",
      error: null,
      initialPrompt: "**Inspect** the app",
      finalOutput: "## Finished",
      questionBatches: [
        {
          id: "batch-1",
          nativeRequestId: "request-1",
          status: "ANSWERED",
          questions: [
            {
              id: "question-1",
              position: 0,
              header: "Scope",
              prompt: "Which area should change?",
              multiSelect: false,
              allowCustom: true,
              options: [
                {
                  id: "option-1",
                  position: 0,
                  label: "Runs",
                  description: null,
                },
              ],
            },
          ],
          answerRevisions: [
            {
              id: "revision-1",
              revision: 0,
              answers: { "question-1": { answers: ["Runs"] } },
              createdAt: "2026-07-23T12:43:00.000Z",
              supersededAt: null,
              replacementAttemptId: null,
            },
          ],
          createdAt: "2026-07-23T12:42:55.000Z",
          answeredAt: "2026-07-23T12:43:00.000Z",
          supersededAt: null,
          revisionPreparedAt: null,
          rollbackPatch: null,
          pushedCommitWarning: null,
          checkpoint: {
            id: "checkpoint-question",
            kind: "QUESTION",
            headSha: "abc123",
            branch: "main",
            upstreamSha: null,
            indexTree: null,
            worktreeTree: "tree-1",
            refName: "refs/aide/question",
            diffSummary: null,
            diffPatch: null,
            stashRef: null,
            createdAt: "2026-07-23T12:42:54.000Z",
          },
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-1",
          kind: "FINISH",
          headSha: "def456",
          branch: "main",
          upstreamSha: null,
          indexTree: null,
          worktreeTree: "tree-2",
          refName: "refs/aide/finish",
          diffSummary: "1 file changed",
          diffPatch:
            "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
          stashRef: null,
          createdAt: "2026-07-23T12:44:00.000Z",
        },
      ],
    };
    eventData = [
      {
        id: "event-1",
        runId: runData.id,
        attemptId: null,
        sequence: 1,
        type: "TOOL_CALL",
        summary: "Read the source",
        detailMarkdown: "Opened `src/app.ts`.",
        raw: { path: "src/app.ts" },
        createdAt: "2026-07-23T12:43:30.000Z",
        supersededAt: null,
      },
    ];

    render(<RunDetailPage runId="run-353" />);

    expect(await screen.findByText("Which area should change?")).toBeDefined();
    expect(screen.getByText("Runs")).toBeDefined();

    const promptHeader = screen
      .getByText("Prompt")
      .closest('[data-slot="card-header"]') as HTMLElement;
    expect(
      within(promptHeader).getByRole("button", { name: "Raw" }),
    ).toBeDefined();
    const summaryHeader = screen
      .getByText("Summary")
      .closest('[data-slot="card-header"]') as HTMLElement;
    expect(
      within(summaryHeader).getByRole("button", { name: "Raw" }),
    ).toBeDefined();
    expect(
      within(summaryHeader).getByRole("button", { name: "Copy" }),
    ).toBeDefined();

    const activitySearch = screen.getByPlaceholderText("Search activity");
    expect(activitySearch.closest('[data-slot="card-header"]')).not.toBeNull();
    fireEvent.click(await screen.findByText("Read the source"));
    const activityCard = activitySearch.closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    expect(
      within(activityCard).getByRole("button", { name: "Raw" }),
    ).toBeDefined();

    const changedFile = (await screen.findAllByText("src/app.ts")).find(
      (element) => element.closest("button"),
    )!;
    fireEvent.click(changedFile.closest("button")!);
    // The +/- marker is a separate, unselectable span, so the added line's
    // content is its own text node.
    expect(await screen.findByText("new")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
  });

  test("loads activity beyond the first 500 events", async () => {
    eventData = Array.from({ length: 501 }, (_, sequence) => ({
      id: `event-${sequence}`,
      runId: runData.id,
      attemptId: null,
      sequence,
      type: "PROVIDER_DELTA",
      summary: `Event ${sequence}`,
      detailMarkdown: null,
      raw: null,
      createdAt: "2026-07-23T12:43:30.000Z",
      supersededAt: null,
    }));

    render(<RunDetailPage runId="run-353" />);

    expect(await screen.findByText("Event 500")).toBeDefined();
    expect(
      request.mock.calls.some(
        ([query, variables]) =>
          String(query).includes("query RunActivity") &&
          (variables as { afterSequence?: number } | undefined)
            ?.afterSequence === 499,
      ),
    ).toBe(true);
  });
});
