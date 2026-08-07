import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { GitLabMergeRequestsPage } from "./pages";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

const configuration = {
  gitlabSettings: {
    configured: true,
    baseUrl: "https://gitlab.com",
    version: "19.2.0",
    tokenConfigured: true,
  },
  gitlabProjects: [
    {
      id: "project-1",
      name: "widgets",
      pathWithNamespace: "acme/widgets",
      webUrl: "https://gitlab.com/acme/widgets",
      defaultBranch: "main",
      visibility: "private",
      enabled: true,
      webhookId: null,
      webhookState: "NOT_CONFIGURED",
      webhookError: null,
      webhookConfiguredAt: null,
      webhookLastReceivedAt: null,
    },
  ],
};

const mergeRequest = {
  id: "merge-request-1",
  iid: 17,
  projectId: "project-1",
  title: "Add the API",
  description: "",
  state: "OPENED",
  draft: false,
  webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
  sourceBranch: "feature/api",
  targetBranch: "main",
  sha: "abc123",
  author: {
    id: "user-1",
    username: "octocat",
    name: "Octo Cat",
    avatarUrl: null,
    webUrl: "https://gitlab.com/octocat",
  },
  reviewers: [],
  labels: [],
  detailedMergeStatus: "mergeable",
  mergeWhenPipelineSucceeds: false,
  squashOnMerge: false,
  hasConflicts: false,
  blockingDiscussionsResolved: true,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z",
  mergedAt: null,
};

beforeEach(() => {
  requestMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("GitLabMergeRequestsPage", () => {
  test("loads authored merge requests by default", async () => {
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration")) {
        return configuration as never;
      }
      if (query.includes("query GitLabMergeRequests")) {
        expect(variables).toEqual({
          scope: "MINE",
          projectId: null,
          state: "OPENED",
        });
        return { gitlabMergeRequests: { items: [mergeRequest] } } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabMergeRequestsPage />);

    expect(await screen.findByText("Add the API")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Scope" })).toHaveProperty(
      "value",
      "MINE",
    );
  });

  test("does not describe a failed request as an empty result", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("GitLabPageConfiguration")) {
        return configuration as never;
      }
      if (query.includes("query GitLabMergeRequests")) {
        throw new Error("GitLab API request failed (408)");
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabMergeRequestsPage />);

    expect(
      await screen.findByText("GitLab API request failed (408)"),
    ).toBeDefined();
    await waitFor(() => {
      expect(
        screen.queryByText("No merge requests match these filters."),
      ).toBeNull();
    });
  });
});
