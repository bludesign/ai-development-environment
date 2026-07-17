import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { PullRequestsPage } from "./pull-requests-page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function activateTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

const repository = {
  id: "local-repository-1",
  githubId: "repository-1",
  owner: "acme",
  name: "widgets",
  nameWithOwner: "acme/widgets",
  url: "https://github.com/acme/widgets",
  jiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b`,
};

const pullRequest = {
  id: "pull-request-1",
  number: 17,
  title: "APP-42 Add the API",
  url: "https://github.com/acme/widgets/pull/17",
  repositoryGithubId: "repository-1",
  repositoryNameWithOwner: "acme/widgets",
  repositoryUrl: "https://github.com/acme/widgets",
  labels: ["backend", "ready"],
  jiraKey: "APP-42",
  pipelineStatus: "SUCCESS",
  pipelines: [
    {
      id: "check-suite-1",
      name: "CI",
      status: "SUCCESS",
      url: "https://github.com/acme/widgets/actions/runs/1",
      checkSuiteId: "check-suite-1",
      canRetry: true,
    },
  ],
  reviewDecision: "APPROVED",
  unresolvedReviewThreadCount: 2,
  headRefName: "feature/app-42",
  createdAt: "2026-07-01T00:00:00.000Z",
};

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
  window.history.replaceState(null, "", "/pull-requests");
});

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

function configureRequests() {
  requestMock.mockImplementation(async (query, variables) => {
    if (query.includes("GitHubPullRequestConfiguration")) {
      return {
        githubSettings: {
          tokenConfigured: true,
          defaultJiraKeyRegex: String.raw`\b([A-Z][A-Z0-9_]*-\d+)\b`,
          updatedAt: new Date(0).toISOString(),
        },
        githubRepositories: [repository],
      } as never;
    }
    if (query.includes("query GitHubPullRequests")) {
      return {
        githubPullRequests: {
          items:
            variables?.scope === "REVIEW_REQUESTED"
              ? [{ ...pullRequest, id: "review-1", title: "Review this" }]
              : [pullRequest],
          truncated: false,
        },
      } as never;
    }
    if (query.includes("GitHubAvailableRepositories")) {
      return {
        githubAvailableRepositories: {
          items: [
            {
              githubId: "repository-2",
              nameWithOwner: "acme/platform",
              url: "https://github.com/acme/platform",
              isPrivate: true,
              managed: false,
            },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      } as never;
    }
    if (query.includes("AddGitHubRepository")) {
      return {
        addGitHubRepository: [
          repository,
          {
            ...repository,
            id: "local-repository-2",
            githubId: "repository-2",
            name: "platform",
            nameWithOwner: "acme/platform",
            url: "https://github.com/acme/platform",
          },
        ],
      } as never;
    }
    if (query.includes("SaveDefaultGitHubJiraKeyRegex")) {
      return {
        saveGitHubSettings: {
          tokenConfigured: true,
          defaultJiraKeyRegex: String(
            (variables?.input as { defaultJiraKeyRegex?: string })
              ?.defaultJiraKeyRegex,
          ),
          updatedAt: new Date().toISOString(),
        },
      } as never;
    }
    if (query.includes("RetryGitHubPipeline")) {
      return {
        retryGitHubPipeline: {
          ...pullRequest.pipelines[0],
          status: "QUEUED",
          canRetry: false,
        },
      } as never;
    }
    if (query.includes("query JiraTicket")) {
      throw new Error("Jira is not configured in this test");
    }
    throw new Error(`Unexpected operation: ${query}`);
  });
}

describe("PullRequestsPage", () => {
  test("renders pull request fields, loads tabs lazily, refreshes, and routes clicks correctly", async () => {
    configureRequests();
    render(<PullRequestsPage />);

    expect(await screen.findByRole("tab", { name: "Mine" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Review requests" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Repositories" })).toBeDefined();

    const title = await screen.findByRole("link", {
      name: "APP-42 Add the API",
    });
    const row = title.closest("tr");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLTableRowElement).getByText("backend"),
    ).toBeDefined();
    expect(
      within(row as HTMLTableRowElement).getByRole("button", {
        name: /Passed/,
      }).className,
    ).toContain("bg-emerald-500/10");
    expect(
      within(row as HTMLTableRowElement).getByText("Approved").className,
    ).toContain("bg-emerald-500/10");
    expect(
      within(row as HTMLTableRowElement)
        .getByRole("link", { name: "View 2 open comments" })
        .getAttribute("href"),
    ).toBe("/comments?pullRequest=acme%2Fwidgets%2317");
    const jiraBadge = within(row as HTMLTableRowElement).getByRole("button", {
      name: "APP-42",
    });
    for (const className of ["rounded-4xl", "px-2", "py-0.5", "text-xs"]) {
      expect(jiraBadge.className).toContain(className);
    }

    expect(title.getAttribute("href")).toBe("/pull-requests/acme/widgets/17");
    expect(
      within(row as HTMLTableRowElement).getByText("feature/app-42"),
    ).toBeDefined();

    fireEvent.pointerDown(
      within(row as HTMLTableRowElement).getByRole("button", {
        name: /Passed/,
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(await screen.findByText("CI")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RetryGitHubPipeline"),
        { repositoryId: "repository-1", checkSuiteId: "check-suite-1" },
      ),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    activateTab(screen.getByRole("tab", { name: "Review requests" }));
    await screen.findByText("Review this");
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringContaining("query GitHubPullRequests"),
      { scope: "REVIEW_REQUESTED", repositoryId: null },
    );

    const callsBeforeRefresh = requestMock.mock.calls.filter(([query]) =>
      String(query).includes("query GitHubPullRequests"),
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        requestMock.mock.calls.filter(([query]) =>
          String(query).includes("query GitHubPullRequests"),
        ).length,
      ).toBeGreaterThan(callsBeforeRefresh),
    );

    activateTab(screen.getByRole("tab", { name: "Repositories" }));
    expect(
      (await screen.findByRole("combobox", { name: "Repository" })).textContent,
    ).toContain("acme/widgets");
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query GitHubPullRequests"),
        { scope: "REPOSITORY", repositoryId: "local-repository-1" },
      ),
    );
    activateTab(screen.getByRole("tab", { name: "Review requests" }));

    const reviewRow = (await screen.findByText("Review this")).closest("tr");
    expect(reviewRow).not.toBeNull();
    fireEvent.click(
      within(reviewRow as HTMLTableRowElement).getByRole("button", {
        name: "APP-42",
      }),
    );
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(
      "APP-42",
    );
  });

  test("browses repositories and supports exact owner/name entry", async () => {
    configureRequests();
    render(<PullRequestsPage />);
    await screen.findByRole("tab", { name: "Mine" });

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByText("acme/platform")).toBeDefined();
    expect(screen.getByText("Private repository")).toBeDefined();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search available repositories" }),
      { target: { value: "missing" } },
    );
    expect(screen.queryByText("acme/platform")).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search available repositories" }),
      { target: { value: "platform" } },
    );
    expect(screen.getByText("acme/platform")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Default ticket key regex"), {
      target: { value: String.raw`\b([A-Z]+-\d+)\b` },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save default ticket key regex",
      }),
    );
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveDefaultGitHubJiraKeyRegex"),
        { input: { defaultJiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b` } },
      ),
    );

    activateTab(screen.getByRole("tab", { name: "Enter manually" }));
    fireEvent.change(screen.getByLabelText("Repository owner/name"), {
      target: { value: "acme/platform" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("AddGitHubRepository"),
        expect.objectContaining({
          input: expect.objectContaining({ nameWithOwner: "acme/platform" }),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    activateTab(await screen.findByRole("tab", { name: "Repositories" }));
    const repositoryPicker = await screen.findByRole("combobox", {
      name: "Repository",
    });
    fireEvent.click(repositoryPicker);
    expect(
      await screen.findByRole("option", { name: "acme/platform" }),
    ).toBeDefined();
  });
});
