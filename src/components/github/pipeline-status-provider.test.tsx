// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  GitHubPipelineStatusChangeView,
  GitHubPipelineStatusSnapshotView,
  GitHubPipelineRecordView,
} from "@/services/github/types";

const client = vi.hoisted(() => ({
  connected: null as (() => void) | null,
  observer: null as {
    next: (value: {
      data?: { githubPipelineStatusChanged: GitHubPipelineStatusChangeView };
    }) => void;
  } | null,
  request: vi.fn(),
  subscribe: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: client.request,
  controlPlaneSubscriptions: () => ({
    subscribe: client.subscribe,
  }),
  onControlPlaneRecovery: (listener: () => void) => {
    client.connected = listener;
    return () => {
      client.connected = null;
    };
  },
}));

import {
  GitHubPipelineStatusProvider,
  useGitHubPipelineSnapshot,
  useGitHubPipelineRecords,
} from "./pipeline-status-provider";

function snapshot(
  repositoryGithubId: string,
  headSha: string,
  revision: number,
  pipelineStatus: GitHubPipelineStatusSnapshotView["pipelineStatus"],
): GitHubPipelineStatusSnapshotView {
  return {
    repositoryGithubId,
    repositoryNameWithOwner: "acme/widgets",
    repositoryUrl: "https://github.com/acme/widgets",
    headSha,
    pipelineStatus,
    pipelines: [],
    revision,
    updatedAt: new Date(revision).toISOString(),
  };
}

function Status({ seed }: { seed: GitHubPipelineStatusSnapshotView }) {
  const key = useMemo(
    () => ({
      repositoryGithubId: seed.repositoryGithubId,
      headSha: seed.headSha,
    }),
    [seed.headSha, seed.repositoryGithubId],
  );
  const value = useGitHubPipelineSnapshot(key, seed);
  return (
    <div>{`${value?.headSha}:${value?.pipelineStatus}:${value?.revision}`}</div>
  );
}

function PipelineDetails({ seed }: { seed: GitHubPipelineStatusSnapshotView }) {
  const value = useGitHubPipelineSnapshot(
    {
      repositoryGithubId: seed.repositoryGithubId,
      headSha: seed.headSha,
    },
    seed,
  );
  const pipeline = value!.pipelines[0]!;
  return (
    <div>{`${pipeline.workflowRunId}:${pipeline.jobs.length}:${pipeline.jobs[0]?.runAttempt}`}</div>
  );
}

function UnstableSeedStatus({ onRender }: { onRender: () => void }) {
  onRender();
  // Mirrors callers that rebuild the seed (and its pipelines) on every render.
  const value = useGitHubPipelineSnapshot(
    { repositoryGithubId: "repo-loop", headSha: "sha-loop" },
    snapshot("repo-loop", "sha-loop", 0, "PENDING"),
  );
  return <div>{`loop:${value?.pipelineStatus}`}</div>;
}

function Records({ ids, revision = 1 }: { ids: string[]; revision?: number }) {
  const seeds: GitHubPipelineRecordView[] = ids.map((id) => ({
    id,
    workflowRunId: id,
    name: id,
    repositoryGithubId: "repo-1",
    headSha: "sha-1",
    status: "SUCCESS",
    url: null,
    checkSuiteId: null,
    canRetry: false,
    retryUnavailableReason: null,
    jobs: [],
    revision,
    isCurrent: true,
  }));
  const records = useGitHubPipelineRecords(
    ids.map((workflowRunId) => ({
      repositoryGithubId: "repo-1",
      workflowRunId,
    })),
    seeds,
  );
  return (
    <div data-testid="records">
      {[...records.values()]
        .map((record) => `${record.id}:${record.revision}`)
        .join(",")}
    </div>
  );
}

describe("GitHubPipelineStatusProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.connected = null;
    client.observer = null;
    client.request.mockResolvedValue({
      githubPipelineStatuses: [],
      githubPipelineRecords: [],
    });
    client.subscribe.mockImplementation(
      (_request: unknown, observer: typeof client.observer) => {
        client.observer = observer;
        return client.dispose;
      },
    );
  });

  test("accepts only higher revisions and isolates repository/SHA keys", async () => {
    const initial = snapshot("repo-1", "sha-1", 1, "PENDING");
    const { rerender } = render(
      <GitHubPipelineStatusProvider>
        <Status seed={initial} />
      </GitHubPipelineStatusProvider>,
    );
    expect(screen.getByText("sha-1:PENDING:1")).toBeDefined();
    await waitFor(() => expect(client.observer).not.toBeNull());

    act(() => {
      client.observer!.next({
        data: {
          githubPipelineStatusChanged: {
            snapshot: snapshot("repo-1", "sha-1", 2, "SUCCESS"),
            changedPipeline: null,
          },
        },
      });
    });
    expect(screen.getByText("sha-1:SUCCESS:2")).toBeDefined();

    act(() => {
      client.observer!.next({
        data: {
          githubPipelineStatusChanged: {
            snapshot: snapshot("repo-1", "sha-1", 1, "FAILURE"),
            changedPipeline: null,
          },
        },
      });
    });
    expect(screen.getByText("sha-1:SUCCESS:2")).toBeDefined();

    rerender(
      <GitHubPipelineStatusProvider>
        <Status seed={snapshot("repo-1", "sha-2", 1, "FAILURE")} />
      </GitHubPipelineStatusProvider>,
    );
    expect(screen.getByText("sha-2:FAILURE:1")).toBeDefined();
  });

  test("uses a richer projection immediately at the same revision", async () => {
    const sparse = {
      ...snapshot("repo-1", "sha-rich", 3, "SUCCESS"),
      pipelines: [
        {
          id: "pipeline-1",
          name: "CI",
          status: "SUCCESS",
          url: null,
          checkSuiteId: "suite-1",
          canRetry: true,
          retryUnavailableReason: null,
        },
      ],
    } as unknown as GitHubPipelineStatusSnapshotView;
    const rich: GitHubPipelineStatusSnapshotView = {
      ...sparse,
      pipelines: [
        {
          ...sparse.pipelines[0]!,
          workflowRunId: "run-1",
          workflowId: "workflow-1",
          runNumber: 7,
          runAttempt: 2,
          jobs: [
            {
              id: "job-1",
              name: "test",
              status: "SUCCESS",
              url: null,
              canRetry: true,
              retryUnavailableReason: null,
              runAttempt: 2,
              steps: [],
            },
          ],
        },
      ],
    };
    const { rerender } = render(
      <GitHubPipelineStatusProvider>
        <Status seed={sparse} />
      </GitHubPipelineStatusProvider>,
    );
    await waitFor(() => expect(client.observer).not.toBeNull());

    rerender(
      <GitHubPipelineStatusProvider>
        <PipelineDetails seed={rich} />
      </GitHubPipelineStatusProvider>,
    );

    expect(screen.getByText("run-1:1:2")).toBeDefined();

    act(() => {
      client.observer!.next({
        data: {
          githubPipelineStatusChanged: {
            snapshot: sparse,
            changedPipeline: null,
          },
        },
      });
    });
    expect(screen.getByText("run-1:1:2")).toBeDefined();
  });

  test("settles when a caller re-seeds an equal snapshot every render", async () => {
    const onRender = vi.fn();
    render(
      <GitHubPipelineStatusProvider>
        <UnstableSeedStatus onRender={onRender} />
      </GitHubPipelineStatusProvider>,
    );
    await waitFor(() => expect(client.observer).not.toBeNull());
    expect(screen.getByText("loop:PENDING")).toBeDefined();
    expect(onRender.mock.calls.length).toBeLessThan(10);
  });

  test("subscribes once and reconciles watched keys after reconnect", async () => {
    render(
      <GitHubPipelineStatusProvider>
        <Status seed={snapshot("repo-1", "sha-1", 1, "SUCCESS")} />
      </GitHubPipelineStatusProvider>,
    );
    await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
    client.request.mockClear();
    act(() => client.connected?.());
    await waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        expect.stringContaining("query GitHubPipelineStatuses"),
        { keys: [{ repositoryGithubId: "repo-1", headSha: "sha-1" }] },
      ),
    );
  });

  test("batches row registrations and a same-turn reconnect, retaining the last consumer", async () => {
    const tree = (ids: string[]) => (
      <GitHubPipelineStatusProvider>
        {ids.map((id, index) => (
          <Status
            key={`${id}:${index}`}
            seed={snapshot("repo-1", id, 1, "SUCCESS")}
          />
        ))}
      </GitHubPipelineStatusProvider>
    );
    const { rerender } = render(tree(["sha-1", "sha-1", "sha-2", "sha-3"]));
    act(() => client.connected?.());
    await waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    expect(client.request.mock.calls[0][1]).toEqual({
      keys: ["sha-1", "sha-2", "sha-3"].map((headSha) => ({
        repositoryGithubId: "repo-1",
        headSha,
      })),
    });
    expect(
      client.subscribe.mock.calls[0][0].variables.snapshotKeys,
    ).toHaveLength(3);
    client.request.mockClear();
    rerender(tree(["sha-1"]));
    await waitFor(() => expect(client.dispose).toHaveBeenCalledOnce());
    expect(client.request).not.toHaveBeenCalled();
    expect(client.subscribe.mock.calls[1][0].variables.snapshotKeys).toEqual([
      { repositoryGithubId: "repo-1", headSha: "sha-1" },
    ]);
    rerender(tree([]));
    await waitFor(() => expect(client.dispose).toHaveBeenCalledTimes(2));
    expect(client.request).not.toHaveBeenCalled();
  });

  test("does not fetch or subscribe for rows removed before their registration flush", async () => {
    const { rerender } = render(
      <GitHubPipelineStatusProvider>
        <Status seed={snapshot("repo-1", "obsolete", 1, "SUCCESS")} />
      </GitHubPipelineStatusProvider>,
    );
    rerender(
      <GitHubPipelineStatusProvider>{null}</GitHubPipelineStatusProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(client.request).not.toHaveBeenCalled();
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  test("fresh plural keys and seeds update projections without new registrations", async () => {
    const { rerender } = render(
      <GitHubPipelineStatusProvider>
        <Records ids={["run-1", "run-2", "run-1"]} />
      </GitHubPipelineStatusProvider>,
    );
    await waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    expect(client.request.mock.calls[0][1].keys).toHaveLength(2);
    expect(client.subscribe.mock.calls[0][0].variables).toMatchObject({
      snapshotKeys: [],
      includeSnapshots: false,
    });
    rerender(
      <GitHubPipelineStatusProvider>
        <Records ids={["run-2", "run-1"]} revision={2} />
      </GitHubPipelineStatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("records").textContent).toContain("run-1:2"),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.subscribe).toHaveBeenCalledOnce();
    expect(client.dispose).not.toHaveBeenCalled();
  });

  test("ignores a late reconciliation after the final watcher leaves", async () => {
    const pending = Promise.withResolvers<{
      githubPipelineStatuses: GitHubPipelineStatusSnapshotView[];
    }>();
    client.request.mockReturnValueOnce(pending.promise);
    const initial = snapshot("repo-1", "sha-late", 1, "PENDING");
    const { rerender } = render(
      <GitHubPipelineStatusProvider>
        <Status seed={initial} />
      </GitHubPipelineStatusProvider>,
    );
    await waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    rerender(
      <GitHubPipelineStatusProvider>{null}</GitHubPipelineStatusProvider>,
    );
    await waitFor(() => expect(client.dispose).toHaveBeenCalledOnce());
    await act(async () => {
      pending.resolve({
        githubPipelineStatuses: [snapshot("repo-1", "sha-late", 99, "FAILURE")],
      });
      await pending.promise;
    });
    rerender(
      <GitHubPipelineStatusProvider>
        <Status seed={initial} />
      </GitHubPipelineStatusProvider>,
    );
    expect(screen.getByText("sha-late:PENDING:1")).toBeTruthy();
  });
});
