import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { setScreenshotTime } from "./screenshot-time";
import { externalPipelineScriptExample } from "../src/lib/external-pipeline-script-examples";

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    Authorization: "Bearer " + screenshotSessionToken,
  });
  await setScreenshotTime(page);
});

test("repository scripts and write-only secrets preserve unsaved script drafts", async ({
  page,
}) => {
  const repositoryId = "repo-acme-gitlab-platform";
  let config = {
    repositoryId,
    enabled: false,
    retryScript: "return 1;",
    cancelScript: "return 2;",
    secretNames: [] as string[],
    updatedAt: null,
  };
  const mutations: { query: string; variables: Record<string, unknown> }[] = [];
  await page.route("**/api/graphql", async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query.includes("query ExternalPipelineActions("))
      return route.fulfill({
        json: { data: { externalPipelineActions: config } },
      });
    let field: string | undefined;
    if (query.includes("mutation SaveExternalPipelineActions(")) {
      config = { ...config, ...variables.input };
      field = "saveExternalPipelineActions";
    } else if (query.includes("setExternalPipelineSecret(")) {
      config.secretNames = [variables.name];
      field = "setExternalPipelineSecret";
    } else if (query.includes("deleteExternalPipelineSecret(")) {
      config.secretNames = [];
      field = "deleteExternalPipelineSecret";
    }
    if (field) {
      mutations.push({ query, variables });
      return route.fulfill({ json: { data: { [field]: config } } });
    }
    await route.continue();
  });
  await page.goto("/en/codebases/repositories/" + repositoryId);
  await page
    .getByRole("tab", { name: "External pipeline actions", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Use context example for Retry script",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Retry script", { exact: true })).toHaveValue(
    externalPipelineScriptExample("retry", "context"),
  );
  await page
    .getByRole("button", {
      name: "Use HTTP example for Cancel script",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Cancel script", { exact: true })).toHaveValue(
    externalPipelineScriptExample("cancel", "http"),
  );
  expect(mutations).toHaveLength(0);
  await page.getByText("Script context reference", { exact: true }).click();
  await expect(
    page.getByText("context.secrets", { exact: true }),
  ).toBeVisible();
  await page.getByText("Example context object", { exact: true }).click();
  await expect(
    page.getByText(/Illustrative values and selected fields only/),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Enable external actions", exact: true })
    .check();
  await page
    .getByLabel("Retry script", { exact: true })
    .fill("return context.pipeline.sha;");
  await page.getByLabel("Secret name", { exact: true }).fill("API_TOKEN");
  const secret = page.getByLabel("New secret value", { exact: true });
  expect(await secret.getAttribute("type")).toBe("password");
  await secret.fill("test-only-value");
  await page.getByRole("button", { name: "Save secret", exact: true }).click();
  await expect(secret).toHaveValue("");
  await expect(page.getByText("API_TOKEN", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Retry script", { exact: true })).toHaveValue(
    "return context.pipeline.sha;",
  );
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.getByLabel("Secret name", { exact: true })).toHaveValue(
    "API_TOKEN",
  );
  await expect(secret).toHaveValue("");
  await secret.fill("replacement-test-value");
  await page.getByRole("button", { name: "Save secret", exact: true }).click();
  await expect(secret).toHaveValue("");
  await page.getByRole("button", { name: "Save scripts", exact: true }).click();
  await expect.poll(() => config.enabled).toBe(true);
  expect(config.retryScript).toBe("return context.pipeline.sha;");
  expect(config.cancelScript).toBe(
    externalPipelineScriptExample("cancel", "http"),
  );
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("API_TOKEN", { exact: true })).toHaveCount(0);
  expect(mutations).toHaveLength(4);
  expect(mutations[0].variables).toMatchObject({
    repositoryId,
    name: "API_TOKEN",
    value: "test-only-value",
  });
});

test("external job retry and cancel use combined dispatch and display uncertain results", async ({
  page,
}) => {
  const requests: { action: string; jobId: string; pipelineId: string }[] = [];
  const executions: Record<string, unknown>[] = [];
  await page.route("**/api/graphql", async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query.includes("mutation GitLabPipelineAction(")) {
      requests.push(variables);
      const uncertain = variables.action === "CANCEL";
      const execution = {
        id: "execution-" + requests.length,
        action: variables.action,
        origin: "MANUAL",
        status: uncertain ? "UNCERTAIN" : "ACCEPTED",
        nativeStatus: "NOT_REQUESTED",
        externalStatus: uncertain ? "UNCERTAIN" : "ACCEPTED",
        message: uncertain
          ? "Provider timed out; await status updates."
          : "Awaiting provider status updates.",
        output: '{"requested":true}',
        targetedStatusIds: [variables.jobId],
        startedAt: "2026-09-28T12:00:00.000Z",
        completedAt: "2026-09-28T12:00:01.000Z",
      };
      executions.unshift(execution);
      return route.fulfill({
        json: {
          data: {
            runGitLabPipelineAction: {
              pipeline: { id: variables.pipelineId },
              execution,
            },
          },
        },
      });
    }
    if (query.includes("query GitLabPipelineDetails(")) {
      const response = await route.fetch();
      const result = await response.json();
      expect(result.errors).toBeUndefined();
      const external = result.data.gitlabPipelineJobs.find(
        (job: { kind: string }) => job.kind === "EXTERNAL",
      );
      expect(external).toBeDefined();
      external.status = requests.length ? "PENDING" : "SUCCESS";
      external.canRetry = requests.length === 0;
      external.canCancel = requests.length > 0;
      external.finishedAt = null;
      result.data.externalPipelineExecutions = executions;
      return route.fulfill({ response, json: result });
    }
    await route.continue();
  });
  await page.goto("/en/gitlab/pipelines");
  await page.getByRole("button", { name: /Show jobs for #118/ }).click();
  const retry = page.getByRole("button", {
    name: "Retry ci/external-tests",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    action: "RETRY",
    jobId: expect.any(String),
  });
  const cancel = page.getByRole("button", {
    name: "Cancel ci/external-tests",
    exact: true,
  });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    action: "CANCEL",
    jobId: requests[0].jobId,
    pipelineId: requests[0].pipelineId,
  });
  await expect(
    page.getByText("UNCERTAIN: Provider timed out; await status updates.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("External action results", { exact: true }).click();
  await expect(
    page.getByText("Native request: NOT_REQUESTED", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("External request: UNCERTAIN", { exact: false }),
  ).toBeVisible();
});
