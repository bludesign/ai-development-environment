import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  Worktree,
  WorktreeOverview,
  WorktreeSourceControlRequest,
} from "./types";
import type { GitLabMergeRequestSummaryField } from "@/services/gitlab/types";
import {
  ENRICHMENT_MAX_AGE_MS,
  mergeWorktreeEnrichment,
  preserveWorktreeMetadata,
  useWorktreeLoading,
  type IntegrationAvailability,
} from "./use-worktree-loading";
import { WORKTREE_LIST_FIELDS } from "./worktree-graphql";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
const worktree = (overrides: Partial<Worktree> = {}) =>
  ({
    id: "w-1",
    codebaseId: "c-1",
    branch: "feature/APP-1",
    headSha: "head-1",
    ticketKey: "APP-1",
    ticketTitle: "Saved title",
    ticketStatus: "Open",
    pullRequest: null,
    sourceControlRequest: null,
    gitLabPipelines: [],
    ...overrides,
  }) as Worktree;
const overview = (value = worktree(), origin = "gitlab.example/acme/app") =>
  ({
    durationMs: 12,
    agents: [
      {
        agent: { id: "agent-1" },
        codebases: [
          {
            repository: { id: "repo-1", canonicalOrigin: origin },
            codebase: { id: "c-1" },
            worktrees: [value],
          },
        ],
      },
    ],
    tags: [],
    activeMoves: [],
    hiddenCount: 0,
    settings: { editorVariant: "CODE" },
  }) as unknown as WorktreeOverview;
const first = (value: WorktreeOverview) =>
  value.agents[0]!.codebases[0]!.worktrees[0]!;
const result = (value = worktree({ ticketTitle: "Fresh title" })) => ({
  worktreeEnrichment: {
    durationMs: 5,
    warnings: [],
    updates: [{ canonicalOrigin: "gitlab.example/acme/app", worktree: value }],
  },
});
const identity = () =>
  new Map([
    ["w-1", { ...worktree(), canonicalOrigin: "gitlab.example/acme/app" }],
  ]);
const mergeRequest: WorktreeSourceControlRequest = {
  provider: "GITLAB",
  id: "mr-1",
  projectId: "42",
  number: 1,
  title: "New merge request",
  url: "https://gitlab.example/acme/app/-/merge_requests/1",
  isDraft: false,
  headRefName: "feature/APP-1",
  headRefOid: "head-1",
  createdAt: "2026-10-30T12:00:00Z",
  approvalState: "APPROVED",
  unresolvedDiscussionsCount: 0,
};

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(result() as never);
});
afterEach(cleanup);

test("list fields omit GitLab action capability resolvers", () => {
  const fields = WORKTREE_LIST_FIELDS.split("gitLabPipelines {")[1]!;
  expect(fields).not.toContain("canRetry");
  expect(fields).not.toContain("canCancel");
});

test.each([
  { branch: "other" },
  { headSha: "other" },
  { codebaseId: "other" },
  { ticketKey: "APP-2" },
])("rejects old enrichment after checkout identity changes: %j", (changes) => {
  const updated = mergeWorktreeEnrichment(
    overview(worktree(changes)),
    result().worktreeEnrichment.updates,
    "JIRA",
    identity(),
  );
  expect(first(updated).ticketTitle).toBe("Saved title");
});

test("rejects changed repository and removed worktrees", () => {
  const changed = mergeWorktreeEnrichment(
    overview(worktree(), "gitlab.example/other/app"),
    result().worktreeEnrichment.updates,
    "JIRA",
    identity(),
  );
  expect(first(changed).ticketTitle).toBe("Saved title");
  const empty = { ...overview(), agents: [] };
  expect(
    mergeWorktreeEnrichment(
      empty,
      result().worktreeEnrichment.updates,
      "JIRA",
      identity(),
    ).agents,
  ).toEqual([]);
});

test("merges only the requested integration, including authoritative nulls", () => {
  const updated = mergeWorktreeEnrichment(
    overview(worktree({ ahead: 7 })),
    result(worktree({ ahead: 0, ticketTitle: null })).worktreeEnrichment
      .updates,
    "JIRA",
    identity(),
  );
  expect(first(updated).ahead).toBe(7);
  expect(first(updated).ticketTitle).toBeNull();
});

test.each([
  {
    field: "APPROVAL_STATE",
    expected: { approvalState: "APPROVED", unresolvedDiscussionsCount: null },
  },
  {
    field: "UNRESOLVED_DISCUSSIONS_COUNT",
    expected: { approvalState: null, unresolvedDiscussionsCount: 0 },
  },
])(
  "preserves only the failed $field from the same merge request revision",
  ({ field, expected }) => {
    const updated = mergeWorktreeEnrichment(
      overview(worktree({ sourceControlRequest: mergeRequest })),
      result(
        worktree({
          sourceControlRequest: {
            ...mergeRequest,
            title: "Updated title",
            approvalState: null,
            unresolvedDiscussionsCount: null,
          },
        }),
      ).worktreeEnrichment.updates,
      "GITLAB_MERGE_REQUESTS",
      identity(),
      [
        {
          worktreeId: "w-1",
          message: "GitLab unavailable",
          preserveFields: [field as GitLabMergeRequestSummaryField],
        },
      ],
    );
    expect(first(updated).sourceControlRequest).toMatchObject({
      title: "Updated title",
      ...expected,
    });
  },
);

test.each([
  { id: "new-mr" },
  { projectId: "other-project" },
  { headRefOid: "new-commit" },
])(
  "does not preserve details for a different merge request revision: %j",
  (changes) => {
    const updated = mergeWorktreeEnrichment(
      overview(worktree({ sourceControlRequest: mergeRequest })),
      result(
        worktree({
          sourceControlRequest: {
            ...mergeRequest,
            ...changes,
            approvalState: null,
          },
        }),
      ).worktreeEnrichment.updates,
      "GITLAB_MERGE_REQUESTS",
      identity(),
      [
        {
          worktreeId: "w-1",
          message: "GitLab unavailable",
          preserveFields: ["APPROVAL_STATE"],
        },
      ],
    );
    expect(first(updated).sourceControlRequest?.approvalState).toBeNull();
  },
);

test("uses fresh requested-changes status even if the approvals endpoint fails", () => {
  const updated = mergeWorktreeEnrichment(
    overview(worktree({ sourceControlRequest: mergeRequest })),
    result(
      worktree({
        sourceControlRequest: {
          ...mergeRequest,
          approvalState: "CHANGES_REQUESTED",
        },
      }),
    ).worktreeEnrichment.updates,
    "GITLAB_MERGE_REQUESTS",
    identity(),
    [
      {
        worktreeId: "w-1",
        message: "GitLab unavailable",
        preserveFields: ["APPROVAL_STATE"],
      },
    ],
  );
  expect(first(updated).sourceControlRequest?.approvalState).toBe(
    "CHANGES_REQUESTED",
  );
});

test("preserves last good metadata on saved refreshes but drops it after a commit changes", () => {
  const previous = overview(worktree({ ticketTitle: "Fresh title" }));
  expect(
    first(preserveWorktreeMetadata(previous, overview(), overview()))
      .ticketTitle,
  ).toBe("Fresh title");
  expect(
    first(
      preserveWorktreeMetadata(
        previous,
        overview(worktree({ headSha: "head-2" })),
        overview(),
      ),
    ).ticketTitle,
  ).toBe("Saved title");
});

function useLoader(
  appId?: string,
  options?: Parameters<typeof useWorktreeLoading>[2],
) {
  const [value, setValue] = useState<WorktreeOverview | null>(() => overview());
  const loading = useWorktreeLoading(appId, setValue, options);
  return { value, setValue, loading };
}
const kinds = () => request.mock.calls.map(([, variables]) => variables?.kind);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("shows a newly discovered merge request with a warning and retains it on saved refreshes", async () => {
  request.mockImplementation(
    async (_query, variables) =>
      ({
        worktreeEnrichment:
          variables?.kind === "GITLAB_MERGE_REQUESTS"
            ? {
                ...result(
                  worktree({
                    sourceControlRequest: {
                      ...mergeRequest,
                      approvalState: null,
                    },
                  }),
                ).worktreeEnrichment,
                warnings: [
                  {
                    worktreeId: "w-1",
                    message: "Could not refresh approvals",
                    preserveFields: ["APPROVAL_STATE"],
                  },
                ],
              }
            : { updates: [], warnings: [], durationMs: 1 },
      }) as never,
  );
  const { result: hook } = renderHook(() => useLoader());
  act(() => hook.current.loading.saved(overview()));
  await waitFor(() =>
    expect(hook.current.loading.timings.GITLAB_MERGE_REQUESTS.status).toBe(
      "warning",
    ),
  );
  expect(first(hook.current.value!).sourceControlRequest?.id).toBe("mr-1");
  expect(
    first(preserveWorktreeMetadata(hook.current.value!, overview(), overview()))
      .sourceControlRequest?.id,
  ).toBe("mr-1");
});

test("uses changed saved merge request metadata while retaining details from enrichment", () => {
  const storedRequest = {
    ...mergeRequest,
    approvalState: null,
    unresolvedDiscussionsCount: null,
  };
  const before = overview(worktree({ sourceControlRequest: storedRequest }));
  const enriched = overview(worktree({ sourceControlRequest: mergeRequest }));
  const after = overview(
    worktree({ sourceControlRequest: { ...storedRequest, title: "Renamed" } }),
  );
  expect(
    first(preserveWorktreeMetadata(enriched, after, before))
      .sourceControlRequest,
  ).toMatchObject({
    title: "Renamed",
    approvalState: "APPROVED",
    unresolvedDiscussionsCount: 0,
  });
});

test("adopts saved GitLab pipeline status and retains enrichment for pipelines still present", () => {
  const pipeline = {
    id: "pipeline-1",
    projectId: "42",
    status: "RUNNING",
    duration: null,
  } as Worktree["gitLabPipelines"][number];
  const before = overview(worktree({ gitLabPipelines: [pipeline] }));
  const enriched = overview(
    worktree({ gitLabPipelines: [{ ...pipeline, duration: 15 }] }),
  );
  const after = overview(
    worktree({ gitLabPipelines: [{ ...pipeline, status: "SUCCESS" }] }),
  );

  expect(
    first(preserveWorktreeMetadata(enriched, after, before)).gitLabPipelines,
  ).toEqual([expect.objectContaining({ status: "SUCCESS", duration: 15 })]);
  expect(
    first(preserveWorktreeMetadata(enriched, overview(), before))
      .gitLabPipelines,
  ).toEqual([]);
});

test("GitHub enrichment does not replace GitLab details with a saved merge request", () => {
  const enriched = overview(
    worktree({ sourceControlRequest: mergeRequest, canAssignReviewers: true }),
  );
  const update = worktree({
    canAssignReviewers: false,
    sourceControlRequest: { ...mergeRequest, approvalState: null },
  });
  const merged = mergeWorktreeEnrichment(
    enriched,
    result(update).worktreeEnrichment.updates,
    "GITHUB",
    identity(),
  );
  expect(first(merged).sourceControlRequest).toEqual(mergeRequest);
  expect(first(merged).canAssignReviewers).toBe(true);
});

test("an in-flight enrichment cannot erase a newly saved pull request", async () => {
  const origin = "github.com/acme/app";
  const stale = result(worktree({ sourceControlRequest: null }));
  stale.worktreeEnrichment.updates[0]!.canonicalOrigin = origin;
  const finish = Promise.withResolvers<typeof stale>();
  request.mockReturnValue(finish.promise as never);
  const { result: hook } = renderHook(() =>
    useLoader(undefined, {
      integrations: { github: true, gitlab: false, jira: false },
    }),
  );
  act(() => hook.current.loading.saved(overview(worktree(), origin)));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());

  const pullRequest = { id: "pr-1", title: "New pull request" } as NonNullable<
    Worktree["pullRequest"]
  >;
  const saved = overview(worktree({ pullRequest }), origin);
  act(() => hook.current.loading.saved(saved));
  expect(first(hook.current.value!).pullRequest).toEqual(pullRequest);
  await act(async () => finish.resolve(stale));
  expect(hook.current.loading.timings.GITHUB.status).toBe("complete");
  expect(first(hook.current.value!).pullRequest).toEqual(pullRequest);
  expect(request).toHaveBeenCalledOnce();

  act(() => hook.current.loading.saved(overview(worktree(), origin)));
  expect(first(hook.current.value!).pullRequest).toBeNull();
  await act(settle);
  expect(request).toHaveBeenCalledOnce();
});

test("slow pipelines do not block Jira, saved refreshes, or other integration timings", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof result>>();
  request.mockImplementation(async (_query, variables) =>
    variables?.kind === "GITLAB_PIPELINES" ? gate.promise : (result() as never),
  );
  const { result: hook } = renderHook(() => useLoader());
  act(() => {
    hook.current.loading.begin();
    hook.current.loading.saved(overview());
  });
  await waitFor(() =>
    expect(hook.current.loading.timings.JIRA.status).toBe("complete"),
  );
  expect(hook.current.loading.timings.GITLAB_PIPELINES.status).toBe("running");
  expect(hook.current.loading.timings.SAVED.status).toBe("complete");
  expect(first(hook.current.value!).ticketTitle).toBe("Fresh title");
  act(() => {
    hook.current.loading.begin();
    hook.current.loading.saved(overview());
  });
  expect(hook.current.loading.timings.SAVED.status).toBe("complete");
  await act(async () => gate.resolve(result()));
  await waitFor(() =>
    expect(hook.current.loading.timings.GITLAB_PIPELINES.status).toBe(
      "complete",
    ),
  );
});

test("retries only the failed group, forces the read, and retains successful metadata", async () => {
  request.mockImplementation(async (_query, variables) => {
    if (variables?.kind === "GITLAB_PIPELINES" && !variables.force)
      throw new Error("GitLab timed out");
    return result() as never;
  });
  const { result: hook } = renderHook(() => useLoader());
  act(() => hook.current.loading.saved(overview()));
  await waitFor(() =>
    expect(hook.current.loading.timings.GITLAB_PIPELINES.status).toBe("failed"),
  );
  expect(first(hook.current.value!).ticketTitle).toBe("Fresh title");
  request.mockClear();
  act(() => hook.current.loading.retry("GITLAB_PIPELINES"));
  await waitFor(() =>
    expect(hook.current.loading.timings.GITLAB_PIPELINES.status).toBe(
      "complete",
    ),
  );
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    expect.any(String),
    { appId: null, worktreeId: null, kind: "GITLAB_PIPELINES", force: true },
    { signal: expect.any(AbortSignal) },
  );
});

test("aborts old requests on page scope changes and ignores their late results", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof result>>();
  request.mockReturnValue(gate.promise as never);
  const {
    result: hook,
    rerender,
    unmount,
  } = renderHook(({ appId }) => useLoader(appId), {
    initialProps: { appId: "app-1" },
  });
  act(() => hook.current.loading.saved(overview()));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  const signals = request.mock.calls.map((call) => call[2]!.signal!);
  rerender({ appId: "app-2" });
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await act(async () => gate.resolve(result()));
  expect(first(hook.current.value!).ticketTitle).toBe("Saved title");
  expect(hook.current.loading.timings.JIRA.status).toBe("pending");
  act(() => hook.current.loading.saved(overview()));
  unmount();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(request).toHaveBeenCalledTimes(4);
});

test("reads optional metadata once across repeated saved reads, and again only for what changed", async () => {
  const { result: hook } = renderHook(() => useLoader());
  act(() => hook.current.loading.saved(overview()));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(4));

  // Agents report every few seconds; an unchanged saved read asks for nothing.
  for (let index = 0; index < 5; index++) {
    act(() => hook.current.loading.saved(overview()));
    await act(settle);
  }
  expect(request).toHaveBeenCalledTimes(4);

  request.mockClear();
  act(() =>
    hook.current.loading.saved(overview(worktree({ headSha: "head-2" }))),
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(kinds().sort()).toEqual([
    "GITHUB",
    "GITLAB_MERGE_REQUESTS",
    "GITLAB_PIPELINES",
  ]);

  request.mockClear();
  act(() =>
    hook.current.loading.saved(
      overview(worktree({ headSha: "head-2", ticketKey: "APP-2" })),
    ),
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(kinds()).toEqual(["JIRA"]);
});

test("reads optional metadata again once it is old, and at once after a failure", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    request.mockImplementationOnce(async () => {
      throw new Error("GitHub timed out");
    });
    const { result: hook } = renderHook(() => useLoader());
    act(() => hook.current.loading.saved(overview()));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(hook.current.loading.timings.GITHUB.status).toBe("failed"),
    );

    request.mockClear();
    act(() => hook.current.loading.saved(overview()));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(kinds()).toEqual(["GITHUB"]);

    request.mockClear();
    vi.setSystemTime(Date.now() + ENRICHMENT_MAX_AGE_MS - 1_000);
    act(() => hook.current.loading.saved(overview()));
    await act(settle);
    expect(request).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 1_000);
    act(() => hook.current.loading.saved(overview()));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  } finally {
    vi.useRealTimers();
  }
});

test("waits for integration availability and never asks an unconnected integration", async () => {
  const { result: hook, rerender } = renderHook(
    ({ integrations }: { integrations: IntegrationAvailability | "pending" }) =>
      useLoader(undefined, { integrations }),
    { initialProps: { integrations: "pending" } },
  );
  act(() => hook.current.loading.saved(overview()));
  await act(settle);
  expect(request).not.toHaveBeenCalled();

  rerender({ integrations: { github: true, gitlab: false, jira: false } });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(kinds()).toEqual(["GITHUB"]);
  expect(hook.current.loading.timings.GITLAB_PIPELINES.status).toBe("skipped");
  expect(hook.current.loading.timings.JIRA.status).toBe("skipped");

  request.mockClear();
  rerender({ integrations: { github: true, gitlab: true, jira: false } });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(kinds().sort()).toEqual(["GITLAB_MERGE_REQUESTS", "GITLAB_PIPELINES"]);
});

test("scopes optional metadata to the repository of one worktree", async () => {
  const { result: hook } = renderHook(() =>
    useLoader(undefined, { worktreeId: "w-1" }),
  );
  act(() => hook.current.loading.saved(overview()));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  expect(
    request.mock.calls.every(
      ([query, variables]) =>
        String(query).includes("worktreeId: $worktreeId") &&
        variables?.worktreeId === "w-1" &&
        variables.appId === null,
    ),
  ).toBe(true);
});
