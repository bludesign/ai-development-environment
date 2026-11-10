import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { WorktreeBulkMerge } from "./worktree-bulk-merge";

vi.mock("next-intl", async (importOriginal) => {
  const original = await importOriginal<typeof import("next-intl")>();
  const { createTranslator } = await import("use-intl/core");
  const { default: messages } = await import("../../../messages/en.json");
  return {
    ...original,
    useTranslations: (
      namespace?: "worktrees.bulkMerge" | "pullRequests" | "gitlabPages",
    ) => createTranslator({ locale: "en", messages, namespace }),
  };
});

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => () => undefined),
}));

const request = vi.mocked(controlPlaneRequest);
const scope = { appId: "app-1", agentId: "agent-1" };
const createdAt = "2026-11-10T12:00:00.000Z";

function github(worktreeId: string) {
  return {
    worktreeId,
    repositoryName: "Acme",
    agentName: "Build Mac",
    branch: `feature/${worktreeId}`,
    folder: `/worktrees/${worktreeId}`,
    provider: "GITHUB",
    requestKey: "github:acme/app:42",
    requestNumber: 42,
    requestTitle: "Add search",
    requestUrl: "https://github.com/acme/app/pull/42",
    repositoryNameWithOwner: "acme/app",
    reviewedHeadSha: "github-head",
    reviewedTargetBranch: "main",
    blockedReason: null,
    githubOptions: {
      worktreeId,
      worktreeFolder: `/worktrees/${worktreeId}`,
      canMerge: true,
      availableMethods: ["SQUASH", "MERGE"],
      defaultMethod: "SQUASH",
      defaultCommitHeadline: "Add search",
      defaultCommitBody: "Provider default",
      commitEmails: [],
      defaultCommitEmail: null,
      canDeleteWorktree: true,
      defaultDeleteWorktree: true,
      ticketKey: "ACME-42",
      ticketDoneStatusConfigured: true,
      defaultMoveTicketToDone: true,
      canSwitchToDefaultBranch: false,
      baseBranchUpdateOptions: {
        destinationBaseBranch: "main",
        selectedWorktreeIds: ["targeting"],
        worktrees: [
          {
            id: "targeting",
            branch: "feature/targeting",
            folder: "/worktrees/targeting",
            agentName: "Build Mac",
            baseBranch: "feature/search",
            canUpdate: true,
          },
        ],
        results: [],
      },
    },
  };
}

const gitlab = {
  worktreeId: "release",
  repositoryName: "Release",
  agentName: "Build Mac",
  branch: "release/next",
  folder: "/worktrees/release",
  provider: "GITLAB",
  requestKey: "gitlab:24:2",
  requestNumber: 2,
  requestTitle: "Prepare release",
  requestUrl: "https://gitlab.example/acme/release/-/merge_requests/2",
  projectId: "24",
  reviewedHeadSha: "gitlab-head",
  reviewedTargetBranch: "trunk",
  blockedReason: null,
  gitlabOptions: {
    worktreeId: "release",
    worktreeFolder: "/worktrees/release",
    canMerge: true,
    mergeMethod: "merge",
    squashPolicy: "default_off",
    squash: false,
    canRemoveSourceBranch: true,
    removeSourceBranch: true,
    mergeCommitMessage: null,
    squashCommitMessage: null,
    canDeleteWorktree: false,
    defaultDeleteWorktree: false,
    ticketKey: null,
    ticketDoneStatusConfigured: false,
    defaultMoveTicketToDone: false,
    canSwitchToDefaultBranch: true,
    defaultSwitchToDefaultBranch: true,
    switchToDefaultBranchName: "trunk",
  },
};

function dialog() {
  fireEvent.click(screen.getByRole("button", { name: "Bulk Merge" }));
  return within(screen.getByRole("dialog", { name: "Bulk Merge" }));
}

beforeEach(() => {
  request.mockReset();
});

test("selects distinct requests, retains each reviewed draft on refresh, and submits only the selected settings", async () => {
  const blocked = {
    ...github("draft"),
    requestKey: "github:acme/app:43",
    blockedReason: "The request is a draft.",
    githubOptions: null,
  };
  request.mockImplementation(async (query) => {
    if (query.includes("query WorktreeMergeCandidates"))
      return {
        worktreeMergeCandidates: [
          github("first"),
          github("chosen"),
          gitlab,
          blocked,
        ],
      } as never;
    if (query.includes("mutation StartWorktreeMergeBatch"))
      return {
        startWorktreeMergeBatch: {
          id: "batch-1",
          status: "ACTIVE",
          items: [{ ...github("chosen"), id: "item-1", status: "SUBMITTING" }],
          createdAt,
          updatedAt: createdAt,
        },
      } as never;
    return { worktreeMergeBatches: [] } as never;
  });
  render(
    <WorktreeBulkMerge
      {...scope}
      disabled={false}
      onReload={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  const sheet = dialog();
  const chosen = await sheet.findByRole("checkbox", {
    name: "Select feature/chosen",
  });
  expect(chosen.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(chosen);
  fireEvent.click(sheet.getByRole("button", { name: "Select all ready" }));
  expect(chosen.getAttribute("aria-checked")).toBe("true");
  expect(
    sheet
      .getByRole("checkbox", { name: "Select feature/first" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    sheet
      .getByRole("checkbox", { name: "Select feature/draft" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    sheet
      .getByRole("checkbox", { name: "Select release/next" })
      .getAttribute("aria-checked"),
  ).toBe("true");

  fireEvent.click(
    sheet.getByRole("button", { name: "Edit settings for feature/chosen" }),
  );
  const headline = await sheet.findByRole("textbox", {
    name: "Commit message",
  });
  fireEvent.change(headline, { target: { value: "Ship search now" } });
  fireEvent.click(
    sheet.getByRole("checkbox", { name: "Delete worktree after merge" }),
  );
  fireEvent.click(
    sheet.getByRole("button", { name: "Edit settings for release/next" }),
  );
  fireEvent.click(
    await sheet.findByRole("checkbox", { name: "Squash commits" }),
  );
  fireEvent.click(
    sheet.getByRole("checkbox", { name: "Delete source branch after merge" }),
  );
  fireEvent.click(
    sheet.getByRole("button", { name: "Refresh merge readiness" }),
  );
  await waitFor(() =>
    expect(
      sheet
        .getByRole("button", { name: "Merge 2 requests" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect((headline as HTMLInputElement).value).toBe("Ship search now");
  expect(
    sheet
      .getByRole("checkbox", { name: "Squash commits" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    sheet.getByRole("region", { name: "Review selected merges" }).textContent,
  ).toContain("Switch to trunk after merge");
  fireEvent.click(sheet.getByRole("button", { name: "Merge 2 requests" }));
  await sheet.findByRole("heading", { name: "Bulk Merge running" });

  const variables = request.mock.calls.find(([query]) =>
    query.includes("mutation StartWorktreeMergeBatch"),
  )?.[1];
  expect(variables).toEqual({
    input: {
      ...scope,
      requestId: expect.any(String),
      items: [
        {
          worktreeId: "chosen",
          requestKey: "github:acme/app:42",
          reviewedHeadSha: "github-head",
          reviewedTargetBranch: "main",
          github: {
            owner: "acme",
            name: "app",
            number: 42,
            worktreeId: "chosen",
            method: "SQUASH",
            commitHeadline: "Ship search now",
            commitBody: "Provider default",
            authorEmail: null,
            deleteWorktree: false,
            moveTicketToDone: true,
            switchToDefaultBranch: false,
            baseBranchUpdate: {
              worktreeIds: ["targeting"],
              destinationBaseBranch: "main",
            },
          },
        },
        {
          worktreeId: "release",
          requestKey: "gitlab:24:2",
          reviewedHeadSha: "gitlab-head",
          reviewedTargetBranch: "trunk",
          gitlab: {
            projectId: "24",
            iid: 2,
            sha: "gitlab-head",
            worktreeId: "release",
            autoMerge: false,
            autoSync: false,
            squash: true,
            removeSourceBranch: false,
            mergeCommitMessage: null,
            squashCommitMessage: null,
            deleteWorktree: false,
            moveTicketToDone: false,
            switchToDefaultBranch: true,
          },
        },
      ],
    },
  });
});

test("recovers the scoped completed batch even when the checkout was removed", async () => {
  request.mockImplementation(async (query) =>
    query.includes("query WorktreeMergeCandidates")
      ? ({ worktreeMergeCandidates: [] } as never)
      : ({
          worktreeMergeBatches: [
            {
              id: "completed",
              status: "COMPLETED",
              items: [
                {
                  ...github("removed"),
                  id: "completed-item",
                  status: "MERGED",
                  postMergeError: "Jira is temporarily unavailable.",
                },
                {
                  ...github("stale"),
                  requestNumber: 43,
                  requestUrl: "",
                  requestTitle: "",
                  id: "skipped-item",
                  status: "SKIPPED",
                  error: "The linked pull request changed.",
                },
              ],
              createdAt,
              updatedAt: createdAt,
            },
          ],
        } as never),
  );
  render(<WorktreeBulkMerge {...scope} disabled onReload={vi.fn()} />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Bulk Merge" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  const sheet = dialog();
  await sheet.findByRole("heading", { name: "Bulk Merge completed" });
  expect(sheet.getByText("Merged")).toBeDefined();
  expect(sheet.getByText("GitHub #43")).toBeDefined();
  expect(sheet.queryByRole("link", { name: "GitHub #43" })).toBeNull();
  expect(
    sheet.getByText("Follow-up warning: Jira is temporarily unavailable."),
  ).toBeDefined();
  expect(
    request.mock.calls.find(([query]) =>
      query.includes("query WorktreeMergeBatches"),
    )?.[1],
  ).toEqual(scope);
});

test("recovers and retains a tracked batch that completes after a newer batch", async () => {
  const olderBatch = {
    id: "older",
    status: "ACTIVE",
    items: [{ ...github("older"), id: "older-item", status: "SUBMITTING" }],
    createdAt,
    updatedAt: createdAt,
  };
  const newerBatch = {
    id: "newer",
    status: "COMPLETED",
    items: [{ ...gitlab, id: "newer-item", status: "MERGED" }],
    createdAt: "2026-11-10T12:00:05.000Z",
    updatedAt: "2026-11-10T12:00:05.000Z",
  };
  let finished = false;
  request.mockImplementation(async (query) => {
    if (query.includes("query WorktreeMergeCandidates"))
      return { worktreeMergeCandidates: [] } as never;
    if (query.includes("query WorktreeMergeBatch("))
      return {
        worktreeMergeBatch: {
          ...olderBatch,
          status: "COMPLETED",
          items: [
            {
              ...olderBatch.items[0],
              status: "FAILED",
              error: "The older merge was rejected.",
            },
          ],
        },
      } as never;
    return {
      worktreeMergeBatches: finished ? [newerBatch] : [olderBatch, newerBatch],
    } as never;
  });
  const onReload = vi.fn().mockResolvedValue(undefined);
  render(<WorktreeBulkMerge {...scope} disabled={false} onReload={onReload} />);
  const sheet = dialog();
  await sheet.findByRole("heading", { name: "Bulk Merge running" });
  finished = true;
  const refresh = sheet.getByRole("button", {
    name: "Refresh merge readiness",
  });
  fireEvent.click(refresh);
  await sheet.findByText("The older merge was rejected.");
  expect(
    sheet.queryByRole("heading", { name: "Bulk Merge running" }),
  ).toBeNull();
  expect(onReload).toHaveBeenCalledTimes(1);
  expect(
    request.mock.calls.find(([query]) =>
      query.includes("query WorktreeMergeBatch("),
    )?.[1],
  ).toEqual({ id: "older" });

  fireEvent.click(refresh);
  await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
  expect(sheet.getByText("The older merge was rejected.")).toBeDefined();
});

test.each([
  ["Select feature/search", "checkbox"],
  ["Select all ready", "button"],
])(
  "preserves reviewed defaults after refresh when selected with %s",
  async (label, role) => {
    const candidate = github("search");
    let defaultDeleteWorktree = false;
    request.mockImplementation(async (query) => {
      if (query.includes("query WorktreeMergeCandidates"))
        return {
          worktreeMergeCandidates: [
            {
              ...candidate,
              githubOptions: {
                ...candidate.githubOptions,
                defaultDeleteWorktree,
              },
            },
          ],
        } as never;
      if (query.includes("mutation StartWorktreeMergeBatch"))
        return {
          startWorktreeMergeBatch: {
            id: "batch-1",
            status: "ACTIVE",
            items: [],
            createdAt,
            updatedAt: createdAt,
          },
        } as never;
      return { worktreeMergeBatches: [] } as never;
    });
    render(
      <WorktreeBulkMerge
        {...scope}
        disabled={false}
        onReload={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const sheet = dialog();
    fireEvent.click(await sheet.findByRole(role, { name: label }));
    const start = sheet.getByRole("button", { name: "Merge 1 request" });
    defaultDeleteWorktree = true;
    fireEvent.click(
      sheet.getByRole("button", { name: "Refresh merge readiness" }),
    );
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    await sheet.findByRole("heading", { name: "Bulk Merge running" });
    expect(
      request.mock.calls.find(([query]) =>
        query.includes("mutation StartWorktreeMergeBatch"),
      )?.[1],
    ).toMatchObject({
      input: { items: [{ github: { deleteWorktree: false } }] },
    });
  },
);

test("requires reselection when the reviewed follow-up destination changes", async () => {
  const candidate = github("search");
  let destinationBaseBranch = "main";
  request.mockImplementation(async (query) =>
    query.includes("query WorktreeMergeCandidates")
      ? ({
          worktreeMergeCandidates: [
            {
              ...candidate,
              githubOptions: {
                ...candidate.githubOptions,
                baseBranchUpdateOptions: {
                  ...candidate.githubOptions.baseBranchUpdateOptions,
                  destinationBaseBranch,
                },
              },
            },
          ],
        } as never)
      : ({ worktreeMergeBatches: [] } as never),
  );
  render(<WorktreeBulkMerge {...scope} disabled={false} onReload={vi.fn()} />);
  const sheet = dialog();
  const select = await sheet.findByRole("checkbox", {
    name: "Select feature/search",
  });
  fireEvent.click(select);
  expect(select.getAttribute("aria-checked")).toBe("true");
  const refresh = sheet.getByRole("button", {
    name: "Refresh merge readiness",
  });
  destinationBaseBranch = "release";
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(select.getAttribute("aria-checked")).toBe("false"),
  );
  expect(
    sheet
      .getByRole("button", { name: "Merge 0 requests" })
      .hasAttribute("disabled"),
  ).toBe(true);

  destinationBaseBranch = "main";
  fireEvent.click(refresh);
  await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
  expect(select.getAttribute("aria-checked")).toBe("false");
});

test("requires reselection when the source commit changes during review", async () => {
  let reviewedHeadSha = "first-head";
  request.mockImplementation(async (query) =>
    query.includes("query WorktreeMergeCandidates")
      ? ({
          worktreeMergeCandidates: [{ ...github("search"), reviewedHeadSha }],
        } as never)
      : ({ worktreeMergeBatches: [] } as never),
  );
  render(<WorktreeBulkMerge {...scope} disabled={false} onReload={vi.fn()} />);
  const sheet = dialog();
  fireEvent.click(
    await sheet.findByRole("checkbox", { name: "Select feature/search" }),
  );
  expect(
    sheet
      .getByRole("button", { name: "Merge 1 request" })
      .hasAttribute("disabled"),
  ).toBe(false);
  reviewedHeadSha = "second-head";
  fireEvent.click(
    sheet.getByRole("button", { name: "Refresh merge readiness" }),
  );
  await sheet.findByText("Merge into main · second-head");
  expect(
    sheet
      .getByRole("checkbox", { name: "Select feature/search" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    sheet
      .getByRole("button", { name: "Merge 0 requests" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
