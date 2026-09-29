import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { setScreenshotTime } from "./screenshot-time";

const mergeOptions = {
  projectId: ids.gitlab.projectId,
  iid: ids.gitlab.mergeRequestIid,
  title: "Improve pipeline retry diagnostics",
  state: "OPENED",
  sha: "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  sourceBranch: "feature/retry-diagnostics",
  targetBranch: "main",
  mergeMethod: "merge",
  squashPolicy: "always",
  squash: true,
  removeSourceBranch: true,
  canRemoveSourceBranch: true,
  canMerge: false,
  canAutoMerge: true,
  canCancelAutoMerge: false,
  autoMergeEnabled: false,
  mergeBlockedReason: "The pipeline is still running.",
  autoMergeBlockedReason: null,
  mergeCommitMessage: null,
  squashCommitMessage: null,
  worktreeId: ids.worktrees.gitlabRetry,
  worktreeFolder: "/Users/acme/Repositories/platform-retry",
  canDeleteWorktree: true,
  ticketKey: "AIDE-145",
  ticketDoneStatusConfigured: true,
  defaultMoveTicketToDone: false,
  defaultDeleteWorktree: false,
  operation: null,
};

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
});

test("gitlab merge sheet shows project policy and deferred follow-ups", async ({
  page,
}, info) => {
  // Keep this visual/interaction verification read-only; provider behavior is covered by service tests.
  await page.route("**/api/graphql", async (route) => {
    const data = route.request().postDataJSON() as { query?: string };
    if (data.query?.includes("query GitLabMergeRequestMergeOptions")) {
      return route.fulfill({
        json: { data: { gitlabMergeRequestMergeOptions: mergeOptions } },
      });
    }
    await route.continue();
  });
  await page.goto(
    `/en/gitlab/merge-requests/${ids.gitlab.projectId}/${ids.gitlab.mergeRequestIid}`,
  );
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("The pipeline is still running.")).toBeVisible();
  await expect(
    sheet.getByRole("checkbox", { name: "Squash commits", exact: true }),
  ).toBeDisabled();
  await expect(
    sheet.getByRole("button", { name: "Merge now", exact: true }),
  ).toBeDisabled();
  await expect(
    sheet.getByRole("button", { name: "Enable auto-merge", exact: true }),
  ).toBeEnabled();
  await expect(sheet.getByText(/AIDE-145/)).toBeVisible();
  await mkdir(`screenshots/${info.project.name}`, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: `screenshots/${info.project.name}/gitlab-merge-options.png`,
    fullPage: true,
  });
});

test("gitlab pipeline expands stages and retry history", async ({
  page,
}, info) => {
  await page.goto("/en/gitlab/pipelines");
  await page.getByRole("button", { name: /Show jobs for #118/ }).click();
  await expect(
    page.getByText("unit-tests", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show retry history", exact: true })
    .click();
  await expect(page.getByText("Retry history", { exact: true })).toBeVisible();
  await mkdir(`screenshots/${info.project.name}`, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: `screenshots/${info.project.name}/gitlab-pipeline-details.png`,
    fullPage: true,
  });
});

test("gitlab scopes require a project only for All accessible and search unmanaged projects", async ({
  page,
}, info) => {
  const requests: { scope: string; projectId?: string }[] = [];
  await page.route("**/api/graphql", async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query?.includes("query GitLabMergeRequests(")) requests.push(variables);
    if (query?.includes("query GitLabAccessibleProjects") && variables.search) {
      return route.fulfill({
        json: {
          data: {
            gitlabAccessibleProjects: {
              items: [
                {
                  id: "204",
                  name: "Mobile",
                  pathWithNamespace: "acme/mobile",
                  webUrl: "https://gitlab.acme.example.com/gitlab/acme/mobile",
                  defaultBranch: "main",
                  visibility: "private",
                  alreadyManaged: false,
                },
              ],
              total: 1,
              page: 1,
              perPage: 25,
              nextPage: null,
            },
          },
        },
      });
    }
    await route.continue();
  });
  await page.goto("/en/gitlab/merge-requests");
  await expect(
    page.getByRole("heading", { name: "Merge Requests", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Improve pipeline retry diagnostics", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.scope).toBe("MINE");
  await page.getByRole("tab", { name: "All accessible", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeDisabled();
  expect(requests.some((request) => request.scope === "ALL")).toBe(false);
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page
    .getByRole("option", { name: "acme/platform", exact: true })
    .click();
  await expect(
    page.getByText("Improve pipeline retry diagnostics", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)).toMatchObject({
    scope: "ALL",
    projectId: ids.gitlab.projectId,
  });
  await page.getByRole("tab", { name: "Review requests", exact: true }).click();
  await expect(
    page.getByText("Improve pipeline retry diagnostics", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)).toMatchObject({
    scope: "REVIEW_REQUESTED",
    projectId: ids.gitlab.projectId,
  });
  await expect(page).toHaveURL(/scope=REVIEW_REQUESTED/);
  await page.getByRole("combobox", { name: "Project", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search accessible projects…", exact: true })
    .fill("acme/mobile");
  await expect(
    page.getByRole("option", { name: "acme/mobile", exact: true }),
  ).toBeVisible();
  await mkdir(`screenshots/${info.project.name}`, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: `screenshots/${info.project.name}/gitlab-project-selector.png`,
    fullPage: true,
  });
});

test("gitlab comments shows human conversations with filters and remembered layout", async ({
  page,
}, info) => {
  await page.goto("/en/gitlab/comments");
  await expect(
    page.getByRole("heading", { name: "Comments", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("General comment", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Retrying here can race/)).toBeVisible();
  await expect(
    page.getByText("src/services/gitlab/auto-retry.ts · L84", { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "Unresolved", exact: true }).check();
  await expect(page.getByText("General comment", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/Retrying here can race/)).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Unresolved", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Other Users", exact: true })
    .uncheck();
  await expect(
    page.getByText("General comment", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Retrying here can race/)).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: "Other Users", exact: true })
    .check();
  await page.getByRole("radio", { name: "Table layout", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("table")).toBeVisible();
  await mkdir(`screenshots/${info.project.name}`, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: `screenshots/${info.project.name}/gitlab-comments-table.png`,
    fullPage: true,
  });
  await page.getByRole("radio", { name: "Card layout", exact: true }).click();
  await page
    .getByRole("link", { name: "Open discussion", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/project=.*&iid=42&discussion=/);
  await expect(
    page.getByRole("textbox", { name: "Reply", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("General comment", { exact: true }),
  ).toBeVisible();
});

test("gitlab comment replies keep drafts on provider errors", async ({
  page,
}) => {
  let replies = 0;
  await page.route("**/api/graphql", async (route) => {
    const { query } = route.request().postDataJSON();
    if (query?.includes("mutation ReplyToGitLabDiscussion")) {
      replies++;
      return route.fulfill({
        json: { errors: [{ message: "GitLab denied this reply." }] },
      });
    }
    await route.continue();
  });
  await page.goto(
    `/en/gitlab/comments?project=${ids.gitlab.projectId}&iid=42&discussion=c7d6e5f40312a9b8c7d6e5f403122a9b8c7d6e5f`,
  );
  const reply = page.getByRole("textbox", { name: "Reply", exact: true });
  await reply.fill("Please keep this draft.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(page.getByText("GitLab denied this reply.")).toBeVisible();
  await expect(reply).toHaveValue("Please keep this draft.");
  expect(replies).toBe(1);
});

test("gitlab comments refresh retrieves comments posted after the cached result", async ({
  page,
}) => {
  const refreshes: boolean[] = [];
  let refreshedResult: unknown;
  await page.route("**/api/graphql", async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (!query?.includes("query GitLabComments(")) {
      await route.continue();
      return;
    }
    refreshes.push(variables?.refresh === true);
    if (variables?.refresh) {
      // The screenshot environment seeds GitLab responses in its local cache.
      // Keep provider refresh simulated here; the service test exercises cache bypass.
      expect(refreshedResult).toBeDefined();
      await route.fulfill({ json: refreshedResult });
      return;
    }
    const response = await route.fetch();
    const result = await response.json();
    expect(result.errors).toBeUndefined();
    refreshedResult = structuredClone(result);
    result.data.gitlabComments.threads = [];
    await route.fulfill({ response, json: result });
  });
  await page.goto(`/en/gitlab/comments?project=${ids.gitlab.projectId}&iid=42`);
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(refresh).toBeEnabled();
  expect(refreshes.length).toBeGreaterThan(0);
  expect(refreshes.every((refresh) => !refresh)).toBe(true);
  await expect(page.getByText(/Retrying here can race/)).toHaveCount(0);
  await refresh.click();
  await expect(page.getByText(/Retrying here can race/)).toBeVisible();
  await expect(
    page.getByText("General comment", { exact: true }),
  ).toBeVisible();
  expect(refreshes.filter(Boolean)).toEqual([true]);
});

test("gitlab merge request timeouts offer narrowing guidance and retry", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/graphql", async (route) => {
    const { query } = route.request().postDataJSON();
    if (query?.includes("query GitLabMergeRequests(") && fail) {
      fail = false;
      return route.fulfill({
        json: {
          errors: [
            {
              message:
                'GitLab API request failed (408): {"error":"Request timed out"}',
            },
          ],
        },
      });
    }
    await route.continue();
  });
  await page.goto("/en/gitlab/merge-requests");
  const timeout = page
    .getByRole("alert")
    .filter({ hasText: "GitLab took too long" });
  await expect(timeout).toContainText(/project/i);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("Improve pipeline retry diagnostics", { exact: true }),
  ).toBeVisible();
  await expect(timeout).toHaveCount(0);
});
