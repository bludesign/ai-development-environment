import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { sessionSubagentLabels } from "../scripts/mock-data/run-subagents";
import { setScreenshotTime } from "./screenshot-time";

test("Claude agents load independent transcripts and recover a failed request", async ({
  page,
  context,
}, testInfo) => {
  await context.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
  await setScreenshotTime(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const transcriptRequests: string[] = [];
  let failFirstTranscript = true;
  await page.route("**/api/graphql", async (route) => {
    const request = route.request().postDataJSON() as {
      query?: string;
      variables?: { subagentId?: string };
    };
    if (!request.query?.includes("query RunSubagentMessages")) {
      await route.continue();
      return;
    }
    transcriptRequests.push(request.variables?.subagentId ?? "unknown");
    if (failFirstTranscript) {
      failFirstTranscript = false;
      await route.fulfill({
        json: { errors: [{ message: "Temporary agent transcript error" }] },
      });
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { errors?: unknown };
    expect(response.ok()).toBe(true);
    expect(body.errors).toBeUndefined();
    await route.fulfill({ response, json: body });
  });

  const response = await page.goto(`/en/ai/sessions/${ids.runs.sessionSearch}`);
  expect(response?.ok()).toBe(true);
  const agents = page.getByTestId("run-agents-card");
  await expect(agents).toBeVisible();
  await expect(agents.locator('[data-slot="accordion-trigger"]')).toHaveCount(
    4,
  );
  await expect(agents.locator('[data-slot="card-title"]')).toHaveText(
    "Agents4",
  );
  await expect(agents.locator('[data-slot="card-title"] svg')).toHaveCount(0);
  expect(transcriptRequests).toEqual([]);

  const first = agents.getByRole("button", {
    name: new RegExp(`^${sessionSubagentLabels[0]}`),
  });
  const second = agents.getByRole("button", {
    name: new RegExp(`^${sessionSubagentLabels[1]}`),
  });
  if (testInfo.project.name.startsWith("desktop")) {
    expect((await first.boundingBox())!.height).toBeLessThanOrEqual(64);
  }
  await first.click();
  await expect(
    agents.getByText("Temporary agent transcript error", { exact: true }),
  ).toBeVisible();
  await agents.evaluate(async (element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      if (animation.effect?.getTiming().iterations !== Infinity)
        animation.finish();
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  await agents.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => transcriptRequests.length).toBe(2);
  await expect(agents.getByRole("table")).toHaveCount(1);
  await expect(
    agents.getByText("Temporary agent transcript error", { exact: true }),
  ).toHaveCount(0);
  await second.click();
  await expect(agents.getByRole("table")).toHaveCount(2);
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  expect(new Set(transcriptRequests).size).toBe(2);
  for (const table of await agents.getByRole("table").all()) {
    const activityTextRight = await table
      .getByRole("columnheader", { name: "Activity", exact: true })
      .evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return text.getBoundingClientRect().right;
      });
    const statusBounds = await table
      .getByRole("columnheader", { name: "Status", exact: true })
      .boundingBox();
    expect(activityTextRight).toBeLessThanOrEqual(statusBounds!.x);
  }

  const keyboard = agents.locator('[data-slot="accordion-item"]').filter({
    has: page.getByRole("button", {
      name: new RegExp(`^${sessionSubagentLabels[1]}`),
    }),
  });
  await keyboard
    .getByRole("row")
    .filter({ hasText: "npm test -- quick-search.keyboard.test.tsx" })
    .first()
    .click();
  await expect(keyboard.getByText(/8 tests passed/)).toBeVisible();
  const widths = await agents.evaluate((element) => ({
    available: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.available + 1);
  expect(pageErrors).toEqual([]);
});
