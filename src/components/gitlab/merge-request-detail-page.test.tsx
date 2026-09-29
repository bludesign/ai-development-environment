import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { GitLabMergeRequestDetailPage, GitLabMergeRequestsPage } from "./pages";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => {} }),
  onControlPlaneRecovery: () => () => {},
}));
vi.mock("@/components/jira/ticket-drawer", () => ({
  JiraTicketDrawer: ({ issueKey }: { issueKey: string | null }) =>
    issueKey ? <div role="dialog">Ticket {issueKey}</div> : null,
}));
const request = vi.mocked(controlPlaneRequest);
const mr = {
  id: "mr-17",
  projectId: "42",
  iid: 17,
  projectPath: "acme/group/widgets",
  title: "APP-42 Improve API",
  description: "**Readable** description",
  state: "MERGED",
  draft: false,
  webUrl: "https://gitlab.example/acme/group/widgets/-/merge_requests/17",
  sourceBranch: "feature/api",
  targetBranch: "main",
  sha: "reviewed-sha",
  author: {
    id: "7",
    username: "author",
    name: "Author",
    avatarUrl: null,
    webUrl: "https://gitlab.example/author",
  },
  reviewers: [
    {
      id: "8",
      username: "reviewer",
      name: "Reviewer",
      avatarUrl: null,
      webUrl: "https://gitlab.example/reviewer",
    },
  ],
  labels: ["backend"],
  detailedMergeStatus: "not_open",
  mergeWhenPipelineSucceeds: false,
  squashOnMerge: true,
  hasConflicts: false,
  blockingDiscussionsResolved: true,
  createdAt: "2026-09-20T12:00:00Z",
  updatedAt: "2026-09-21T12:00:00Z",
  mergedAt: "2026-09-21T12:00:00Z",
  worktreeId: "checkout-1",
  worktreeHighlightColor: "violet",
  ticketKey: "APP-42",
  approvalState: "APPROVED",
  approvalsRequired: 1,
  approvalsLeft: 0,
  unresolvedDiscussionsCount: 0,
  headPipeline: { id: "99", status: "SUCCESS" },
  mergeOperation: null,
  changesCount: "3",
  commitsCount: 2,
  pipelines: [],
  discussions: [],
};
function mockRequests(detail = mr) {
  request.mockImplementation(async (query) => {
    if (query.includes("GitLabPageConfiguration"))
      return {
        gitlabSettings: { configured: true },
        gitlabProjects: [],
      } as never;
    if (query.includes("query GitLabMergeRequests("))
      return {
        gitlabMergeRequests: {
          items: [detail],
          total: 1,
          page: 1,
          perPage: 25,
          nextPage: null,
        },
      } as never;
    if (query.includes("query GitLabMergeRequest("))
      return { gitlabMergeRequest: detail } as never;
    throw new Error(`Unexpected query: ${query}`);
  });
}
afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("GitLab merge request presentation", () => {
  test("shows table summaries, provider project path, colors, ticket and discussion navigation", async () => {
    mockRequests();
    render(<GitLabMergeRequestsPage />);
    const table = await screen.findByRole("table", {
      name: "Merge Requests",
    });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(9);
    expect(within(table).getByText("Success").className).toContain("emerald");
    expect(within(table).getByText("Approved").className).toContain("emerald");
    expect(
      within(table)
        .getByRole("link", { name: "View 0 open discussions" })
        .getAttribute("href"),
    ).toBe("/gitlab/comments?project=42&iid=17");
    expect(within(table).getByText(/acme\/group\/widgets/)).toBeDefined();
    expect(
      within(table).getByText("APP-42 Improve API").closest("tr")?.className,
    ).toContain("violet");
    fireEvent.click(within(table).getByRole("button", { name: "APP-42" }));
    expect(screen.getByRole("dialog").textContent).toContain("APP-42");
  });

  test("shows detail metadata and rendered Markdown without raw merged status or active merge actions", async () => {
    mockRequests();
    const { container } = render(
      <GitLabMergeRequestDetailPage projectId="42" iid={17} />,
    );
    await screen.findByRole("heading", { name: "APP-42 Improve API" });
    expect(container.querySelector("strong")?.textContent).toBe("Readable");
    expect(
      screen.getByText("Merged", { selector: "span[data-slot=badge]" })
        .className,
    ).toContain("purple");
    expect(screen.getByText("@reviewer")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "View worktree" }).getAttribute("href"),
    ).toContain("checkout-1");
    expect(screen.queryByText("not_open")).toBeNull();
    expect(screen.queryByText("MERGED")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([query]) =>
          query.includes("query GitLabMergeRequest("),
        ),
      ).toHaveLength(2),
    );
  });
});
