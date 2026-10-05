import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { setScreenshotTime } from "./screenshot-time";

test("global focus survives navigation and reload, then restores each page filter", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  await page.addInitScript((collectionId) => {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => collectionId,
    });
  }, ids.ccusageCollections.captured);
  await page.goto("/en/dashboard/worktrees");
  const localAgent = page.getByRole("combobox", {
    name: "Filter by agent",
    exact: true,
  });
  await localAgent.click();
  await page.getByRole("option", { name: "Studio Mac", exact: true }).click();
  await expect(localAgent).toHaveText("Studio Mac");

  const globalAgent = page.getByRole("combobox", {
    name: "Active agent: None",
    exact: true,
  });
  await globalAgent.focus();
  await globalAgent.press("Enter");
  await page
    .getByPlaceholder("Search agents…", { exact: true })
    .fill("build-mac.local");
  await page.getByRole("option").filter({ hasText: "Build Mac" }).click();
  await expect(localAgent).toBeDisabled();
  await expect(localAgent).toHaveText("Build Mac");
  const searchInput = page.getByRole("searchbox", {
    name: "Search worktrees",
    exact: true,
  });
  const searchIcon = page
    .getByRole("search", { name: "Worktree filters", exact: true })
    .locator(".lucide-search");
  await expect
    .poll(async () => {
      const [inputBox, iconBox] = await Promise.all([
        searchInput.boundingBox(),
        searchIcon.boundingBox(),
      ]);
      if (!inputBox || !iconBox) return Number.POSITIVE_INFINITY;
      const inputCenter = inputBox.y + inputBox.height / 2;
      const iconCenter = iconBox.y + iconBox.height / 2;
      return Math.abs(inputCenter - iconCenter);
    })
    .toBeLessThanOrEqual(1);
  await page.reload();
  await expect(localAgent).toBeDisabled();
  await expect(localAgent).toHaveText("Build Mac");

  const secondTab = await context.newPage();
  await secondTab.goto("/en/dashboard/worktrees");
  await expect(
    secondTab.getByRole("combobox", {
      name: "Active agent: Build Mac",
      exact: true,
    }),
  ).toBeVisible();

  await page.goto("/en/ai/usage");
  const usageAgent = page.getByRole("combobox", {
    name: "Filter usage by agent",
    exact: true,
  });
  await expect(usageAgent).toBeDisabled();
  await expect(usageAgent).toHaveText("Build Mac");
  if (test.info().project.name.startsWith("desktop")) {
    await expect
      .poll(async () => {
        const [agentBox, rangeBox] = await Promise.all([
          usageAgent.boundingBox(),
          page.getByRole("tablist", { name: "Usage range" }).boundingBox(),
        ]);
        if (!agentBox || !rangeBox) return Number.POSITIVE_INFINITY;
        return Math.abs(agentBox.y - rangeBox.y);
      })
      .toBeLessThanOrEqual(1);
    await page.screenshot({
      path: test.info().outputPath("usage-active-agent.png"),
    });
  }
  for (const route of ["commands", "workflows", "plans", "sessions"]) {
    const queryName =
      route === "commands"
        ? "CommandManagement"
        : route === "workflows"
          ? "WorkflowManagement"
          : "AgentRuns";
    const response = page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/graphql")) return false;
      const request = response.request().postDataJSON();
      return (
        request?.query?.includes(`query ${queryName}`) &&
        request.variables?.agentId === ids.agents.build
      );
    });
    const section = ["commands", "workflows"].includes(route)
      ? "dashboard"
      : "ai";
    await page.goto(`/en/${section}/${route}`);
    const filter = page.getByRole("combobox", {
      name: "Filter by agent",
      exact: true,
    });
    await expect(filter).toBeDisabled();
    await expect(filter).toHaveText("Build Mac");
    await expect(
      page.getByText("Controlled by Active Agent", { exact: true }),
    ).toBeVisible();
    const body = await (await response).json();
    expect(body.errors).toBeUndefined();
    const runs =
      route === "commands"
        ? body.data.commandRuns.nodes
        : route === "workflows"
          ? body.data.workflowRuns.items
          : body.data.agentRuns.items;
    expect(
      runs.every(
        (run: { agentId?: string; agent?: { id: string } }) =>
          (run.agentId ?? run.agent?.id) === ids.agents.build,
      ),
    ).toBe(true);
    if (test.info().project.name.startsWith("desktop")) {
      await page.screenshot({
        path: test.info().outputPath(`${route}-active-agent.png`),
      });
    }
  }
  await page.goto("/en/ai/usage");
  await page
    .getByRole("combobox", { name: "Active agent: Build Mac", exact: true })
    .click();
  await page.getByRole("option", { name: "None", exact: true }).click();
  await expect(usageAgent).toBeEnabled();
  await expect(usageAgent).toHaveText("All agents");
  await expect(
    secondTab.getByRole("combobox", {
      name: "Active agent: None",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    secondTab.getByRole("combobox", { name: "Filter by agent", exact: true }),
  ).toHaveText("Studio Mac");
  await page.goto("/en/dashboard/worktrees");
  await expect(localAgent).toHaveText("Studio Mac");
  await expect(localAgent).toBeEnabled();
});
