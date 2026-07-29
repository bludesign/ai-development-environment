// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  GitHubPipelineStatusChangeView,
  GitHubPipelineStatusSnapshotView,
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
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: client.request,
  controlPlaneSubscriptions: () => ({
    subscribe: client.subscribe,
  }),
  onControlPlaneConnected: (listener: () => void) => {
    client.connected = listener;
    return () => {
      client.connected = null;
    };
  },
}));

import {
  GitHubPipelineStatusProvider,
  useGitHubPipelineSnapshot,
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

describe("GitHubPipelineStatusProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.connected = null;
    client.observer = null;
    client.request.mockResolvedValue({ githubPipelineStatuses: [] });
    client.subscribe.mockImplementation(
      (_request: unknown, observer: typeof client.observer) => {
        client.observer = observer;
        return () => undefined;
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
});
