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
