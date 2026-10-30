import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { setScreenshotTime } from "./screenshot-time";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("saved worktrees and independent pipeline enrichment execute through the real GraphQL schema", async ({
  request,
}) => {
  const response = await request.post("/api/graphql", {
    headers: { Authorization: `Bearer ${screenshotSessionToken}` },
    data: {
      query: `query {
      worktreeOverview(savedOnly: true) { durationMs agents { codebases { worktrees { id } } } }
      worktreeEnrichment(kind: GITLAB_PIPELINES) { durationMs updates { canonicalOrigin worktree { id gitLabPipelines { id status } } } warnings { worktreeId message } }
    }`,
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  expect(body.data.worktreeOverview.agents.length).toBeGreaterThan(0);
  expect(body.data.worktreeEnrichment.durationMs).toBeGreaterThanOrEqual(0);
  expect(
    body.data.worktreeEnrichment.updates.some(
      (update: { worktree: { id: string } }) =>
        update.worktree.id === ids.worktrees.gitlabRetry,
    ),
  ).toBe(true);
  expect(body.data.worktreeEnrichment.warnings).toEqual([]);
});

for (const [name, path] of [
  ["all worktrees", "/en/dashboard/worktrees"],
  [
    "app worktrees",
    `/en/dashboard/apps/${ids.apps.customerPortal}?view=worktrees`,
  ],
] as const) {
  test(`${name} load before GitLab and keep content stationary when status completes`, async ({
    page,
  }, info) => {
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${screenshotSessionToken}`,
    });
    await setScreenshotTime(page);
    const gate = Promise.withResolvers<void>();
    let pipelinesRequested = false;
    await page.route("**/api/graphql", async (route) => {
      const { query, variables } = route.request().postDataJSON();
      if (query?.includes("query WorktreeEnrichment")) {
        if (variables.kind === "GITLAB_PIPELINES") {
          pipelinesRequested = true;
          await gate.promise;
        }
        return route.fulfill({
          json: {
            data: {
              worktreeEnrichment: {
                updates: [],
                durationMs: 125,
                warnings: [],
              },
            },
          },
        });
      }
      await route.continue();
    });
    await page.goto(path);
    const status = page.getByTestId("worktree-loading-status");
    await expect(status).toContainText("GitLab pipelines");
    expect(pipelinesRequested).toBe(true);
    const filters = page.getByRole("search", { name: "Worktree filters" });
    await expect(filters).toBeVisible();
    await expect(
      page.getByText("feature/quick-search", { exact: true }).first(),
    ).toBeVisible();
    const before = await filters.boundingBox();
    const statusBefore = await status.boundingBox();
    await status.getByRole("button", { name: "Loading details" }).click();
    await expect(
      page.getByText("GitLab pipelines", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Server: 0\.13s/).first()).toBeVisible();
    expect((await filters.boundingBox())?.y).toBe(before?.y);
    await page.screenshot({
      path: info.outputPath("worktree-loading-details.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    gate.resolve();
    await expect(status).toContainText("Worktrees updated");
    expect((await status.boundingBox())?.height).toBe(statusBefore?.height);
    expect((await filters.boundingBox())?.y).toBe(before?.y);
  });
}

test("GitLab pipeline action checks wait until the menu opens", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  const gate = Promise.withResolvers<void>();
  let checks = 0;
  await page.route("**/api/graphql", async (route) => {
    const { query } = route.request().postDataJSON();
    if (query?.includes("query WorktreePipelineActions")) {
      checks++;
      await gate.promise;
      return route.fulfill({
        json: { data: { gitlabPipeline: { canRetry: true } } },
      });
    }
    if (query?.includes("query WorktreeEnrichment"))
      return route.fulfill({
        json: {
          data: {
            worktreeEnrichment: { updates: [], durationMs: 10, warnings: [] },
          },
        },
      });
    if (query?.includes("query WorktreeOverview")) {
      const response = await route.fetch();
      const body = await response.json();
      const worktree =
        body.data.worktreeOverview.agents[0].codebases[0].worktrees[0];
      worktree.gitLabPipelines = [
        {
          id: "947",
          projectId: "42",
          iid: "47",
          ref: worktree.branch,
          branch: worktree.branch,
          sha: worktree.headSha,
          source: "push",
          status: "FAILED",
          webUrl: "https://gitlab.example/acme/app/-/pipelines/947",
          mergeRequests: [],
          worktreeId: worktree.id,
        },
      ];
      return route.fulfill({ json: body });
    }
    await route.continue();
  });
  await page.goto("/en/dashboard/worktrees");
  const menu = page
    .getByRole("button", { name: "Pipelines: Failed", exact: true })
    .first();
  await expect(menu).toBeVisible();
  expect(checks).toBe(0);
  await menu.click();
  await expect(
    page.getByRole("menuitem", { name: /Checking actions/ }),
  ).toBeDisabled();
  expect(checks).toBe(1);
  gate.resolve();
  await expect(
    page.getByRole("menuitem", { name: "Retry", exact: true }),
  ).toBeEnabled();
});
