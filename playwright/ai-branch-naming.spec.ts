import { expect, test, type Page } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { DEFAULT_JIRA_BRANCH_NAMING_PROMPT } from "../packages/agent-contract/src/worktrees";
import { setScreenshotTime } from "./screenshot-time";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function stubNaming(page: Page) {
  let state: "pending" | "generated" | "error" = "generated";
  const submissions: Array<{ selection: { branchName?: string } }> = [];
  let generations = 0;
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  await page.route("**/api/graphql", async (route) => {
    const body = route.request().postDataJSON();
    const query = String(body.query);
    const reply = (data: unknown) => route.fulfill({ json: { data } });
    if (query.includes("query RunProviderCatalog"))
      return reply({
        runProviderCatalog: [
          {
            key: "CODEX",
            label: "Codex",
            available: true,
            supportsWebSearch: true,
            models: [
              {
                id: "default",
                label: "Provider default",
                efforts: ["auto", "low", "medium", "high"],
                group: null,
              },
            ],
          },
        ],
      });
    if (query.includes("mutation GenerateWorktreeTicketBranch")) {
      generations++;
      return reply({ generateWorktreeTicketBranch: { id: "branch-preview" } });
    }
    if (query.includes("query TicketBranchJob"))
      return reply({
        agentJob: {
          status:
            state === "pending"
              ? "RUNNING"
              : state === "error"
                ? "FAILED"
                : "SUCCEEDED",
          error:
            state === "error"
              ? "The selected model is unavailable. Retry generation."
              : null,
          worktreeTicketBranchResult:
            state === "generated"
              ? { branchName: "feature/ACME-1234-quick-search" }
              : null,
        },
      });
    if (query.includes("query WorktreeTicketBranchContext"))
      return reply({
        worktreeTicketBranchContext: {
          ticketKey: "ACME-1234",
          ticketTitle: "Add quick search to the global navigation bar",
          ticketType: "Story",
          projectKey: "ACME",
          branchNamingMode: "AI",
          branchName: null,
        },
      });
    if (
      query.includes("mutation CreateWorktree") ||
      query.includes("mutation ChangeWorktreeBranch")
    ) {
      submissions.push(body.variables.input);
      return reply(
        query.includes("mutation CreateWorktree")
          ? { createWorktree: { id: "branch-operation" } }
          : { changeWorktreeBranch: { id: "branch-operation" } },
      );
    }
    if (query.includes("query WorktreeJob"))
      return reply({
        agentJob: {
          status: "SUCCEEDED",
          error: null,
          worktreeOperationResult: null,
        },
      });
    if (query.includes("mutation CancelBranchGeneration"))
      return reply({ cancelAgentJob: { id: "branch-preview" } });
    if (!query.includes("jiraProjects") && !query.includes("worktreeOverview"))
      return route.continue();
    const response = await route.fetch();
    const result = await response.json();
    if (result.data?.jiraProjects) {
      result.data.jiraProjects = result.data.jiraProjects.map(
        (project: { id: string }) =>
          project.id === ids.jira.projectId
            ? {
                ...project,
                branchNamingMode: "AI",
                branchNamingProvider: "CODEX",
                branchNamingModel: "default",
                branchNamingEffort: "low",
                branchNamingPrompt: DEFAULT_JIRA_BRANCH_NAMING_PROMPT,
              }
            : project,
      );
    }
    if (result.data?.worktreeOverview) {
      result.data.worktreeOverview.agents =
        result.data.worktreeOverview.agents.filter(
          (group: { agent: { id: string } }) =>
            group.agent.id === ids.agents.studio,
        );
      for (const group of result.data.worktreeOverview.agents) {
        group.agent.connectionStatus = "ONLINE";
        group.agent.capabilities = [
          ...new Set([
            ...group.agent.capabilities,
            "worktree.branch",
            "jira.branch.generate",
          ]),
        ];
        group.codebases = group.codebases.filter(
          (entry: { codebase: { id: string } }) =>
            entry.codebase.id === ids.codebases.web,
        );
        for (const entry of group.codebases) {
          entry.blockingJob = null;
          entry.codebase.availability = "AVAILABLE";
          for (const worktree of entry.worktrees) worktree.activeJob = null;
        }
      }
    }
    await route.fulfill({ response, json: result });
  });
  return {
    setState: (value: typeof state) => {
      state = value;
    },
    submissions,
    generationCount: () => generations,
  };
}

for (const action of ["create", "change"] as const) {
  test(`AI branch naming ${action}`, async ({ page }, testInfo) => {
    const stub = await stubNaming(page);
    await page.goto("/en/dashboard/worktrees");
    if (action === "change") {
      await page
        .getByRole("button", { name: "Customize worktree", exact: true })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: "Change branch", exact: true })
        .click();
    }
    const form =
      action === "create"
        ? page.locator("form").filter({
            has: page.getByRole("button", {
              name: "Create worktree",
              exact: true,
            }),
          })
        : page.locator("form").filter({
            has: page.getByRole("button", {
              name: "Change branch",
              exact: true,
            }),
          });
    await form.getByRole("tab", { name: "From ticket" }).click();
    await form.getByLabel("Ticket key", { exact: true }).fill("ACME-1234");
    await expect(
      form.getByText("Add quick search to the global navigation bar", {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `screenshots/${testInfo.project.name}/worktree-ai-${action}.png`,
      animations: "disabled",
    });
    expect(stub.generationCount()).toBe(0);
    stub.setState("pending");
    await form
      .getByRole("button", { name: "Generate branch name", exact: true })
      .click();
    await expect(
      form.getByRole("button", {
        name: /Generating branch name…/,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `screenshots/${testInfo.project.name}/worktree-ai-${action}-pending.png`,
      animations: "disabled",
    });
    stub.setState("generated");
    await expect(form.getByLabel("Branch name", { exact: true })).toHaveValue(
      "feature/ACME-1234-quick-search",
    );
    await page.screenshot({
      path: `screenshots/${testInfo.project.name}/worktree-ai-${action}-generated.png`,
      animations: "disabled",
    });
    stub.setState("error");
    await form
      .getByRole("button", { name: "Regenerate branch name", exact: true })
      .click();
    await expect(
      form.getByText("The selected model is unavailable. Retry generation."),
    ).toBeVisible();
    await page.screenshot({
      path: `screenshots/${testInfo.project.name}/worktree-ai-${action}-error.png`,
      animations: "disabled",
    });
    await form
      .getByLabel("Branch name", { exact: true })
      .fill("feature/ACME-1234-edited-search");
    await form
      .getByRole("button", {
        name: action === "create" ? "Create worktree" : "Change branch",
        exact: true,
      })
      .click();
    await expect.poll(() => stub.submissions.length).toBe(1);
    expect(stub.submissions[0]!.selection.branchName).toBe(
      "feature/ACME-1234-edited-search",
    );
    expect(stub.generationCount()).toBe(2);
  });
}

test("AI project branch naming settings", async ({ page }, testInfo) => {
  await stubNaming(page);
  await page.goto("/en/jira/tickets");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("button", { name: /ACME · Acme Platform/ }).click();
  await page
    .getByLabel("Branch naming prompt", { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("switch", { name: "AI branch naming", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "{{ticket.description}}", exact: true })
    .click();
  await expect(
    page.getByLabel("Branch naming prompt", { exact: true }),
  ).toHaveValue(/\{\{ticket.description\}\}/);
  await page.screenshot({
    path: `screenshots/${testInfo.project.name}/jira-ai-branch-settings.png`,
    animations: "disabled",
  });
});
