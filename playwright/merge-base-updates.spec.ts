import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { baseBranchUpdateOptions } from "./merge-base-fixture";
import {
  normalizeScreenshotValues,
  setScreenshotTime,
} from "./screenshot-time";
import { stubWorktreeAgent } from "./worktree-stub";

const mergeOptions = {
  defaultMethod: "SQUASH",
  defaultMoveTicketToDone: false,
  defaultDeleteWorktree: false,
  worktreeId: ids.worktrees.webFeature,
  worktreeFolder: "/Users/acme/Repositories/app-search",
  canDeleteWorktree: true,
  ticketKey: "AIDE-145",
  ticketDoneStatusConfigured: true,
  availableMethods: ["SQUASH", "MERGE", "REBASE"],
  commitEmails: ["alex@acme.example"],
  defaultCommitEmail: "alex@acme.example",
  defaultCommitHeadline: "[AIDE-145] Improve search",
  defaultCommitBody: "",
  canMerge: true,
  canEnableAutoMerge: true,
  autoMergeEnabled: false,
  viewerCanDisableAutoMerge: true,
  mergeStateStatus: "CLEAN",
  headRefOid: "abc123",
  blockedReason: null,
  baseBranchUpdateOptions,
};

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  await stubWorktreeAgent(page);
});

for (const automatic of [false, true]) {
  test(`GitHub ${automatic ? "Auto Merge" : "Merge"} offers targeting worktrees across agents`, async ({
    page,
  }, info) => {
    await page.route("**/api/graphql", async (route) => {
      const request = route.request().postDataJSON() as { query?: string };
      if (request.query?.includes("query GitHubPullRequestMergeOptions"))
        return route.fulfill({
          json: {
            data: {
              githubPullRequestMergeOptions: {
                ...mergeOptions,
                canMerge: !automatic,
              },
            },
          },
        });
      if (automatic && request.query?.includes("query WorktreeDetail")) {
        const response = await route.fetch();
        const json = await response.json();
        const visit = (value: unknown) => {
          if (!value || typeof value !== "object") return;
          const object = value as Record<string, unknown>;
          if (object.pullRequest && typeof object.pullRequest === "object") {
            Object.assign(object.pullRequest, {
              mergeStateStatus: "BLOCKED",
              mergeable: "UNKNOWN",
              state: "OPEN",
            });
            object.autoMerge = null;
          }
          Object.values(object).forEach(visit);
        };
        visit(json);
        return route.fulfill({ response, json });
      }
      await route.fallback();
    });
    await page.goto(
      automatic
        ? `/en/dashboard/worktrees/${ids.worktrees.webFeature}`
        : `/en/github/pull-requests/${ids.pullRequests.owner}/${ids.pullRequests.repository}/${ids.pullRequests.number}`,
    );
    await page
      .getByRole("main")
      .getByRole("button", {
        name: automatic ? /Auto Merge/ : "Merge",
        exact: !automatic,
      })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Update targeting worktrees")).toBeVisible();
    const first = dialog.getByRole("checkbox", { name: /search-filters/ });
    await expect(first).not.toBeChecked();
    await first.check();
    await expect(
      dialog.getByRole("checkbox", { name: /search-tests/ }),
    ).not.toBeChecked();
    await normalizeScreenshotValues(page);
    await mkdir(`screenshots/${info.project.name}`, { recursive: true });
    await page.screenshot({
      path: `screenshots/${info.project.name}/${automatic ? "worktree-auto-merge-options" : "github-merge-options"}.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
}
