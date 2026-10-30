import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { Worktree, WorktreeOverview } from "./types";
import {
  mergeWorktreeEnrichment,
  preserveWorktreeMetadata,
  useWorktreeLoading,
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

test("preserves last good metadata on saved refreshes but drops it after a commit changes", () => {
  const previous = overview(worktree({ ticketTitle: "Fresh title" }));
  expect(
    first(preserveWorktreeMetadata(previous, overview())).ticketTitle,
  ).toBe("Fresh title");
  expect(
    first(
      preserveWorktreeMetadata(
        previous,
        overview(worktree({ headSha: "head-2" })),
      ),
    ).ticketTitle,
  ).toBe("Saved title");
});

function useLoader(appId?: string) {
  const [value, setValue] = useState<WorktreeOverview | null>(() => overview());
  const loading = useWorktreeLoading(appId, setValue);
  return { value, setValue, loading };
}

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
    { appId: null, kind: "GITLAB_PIPELINES", force: true },
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
