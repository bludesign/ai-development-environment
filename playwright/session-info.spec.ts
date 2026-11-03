import { expect, test, type Locator, type Page } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import type { AgentRunView } from "../src/components/runs/types";
import { setScreenshotTime } from "./screenshot-time";

const LONG_TRANSCRIPT_PATH = `/Users/provider/Library/Application Support/AI session logs/${"long-workspace-name-without-breaks".repeat(14)}/current-session.jsonl`;
const OLD_TRANSCRIPT_PATH = "/old/session.jsonl";
const CURRENT_NATIVE_ID = "current-native-session";

function infoRow(card: Locator, page: Page, label: string): Locator {
  return card.locator("dl > div").filter({
    has: page.getByText(label, { exact: true }),
  });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

for (const target of [
  { kind: "session", id: ids.runs.sessionSearch, title: "Session info" },
  { kind: "plan", id: ids.runs.planSearch, title: "Plan info" },
] as const) {
  for (const missingCurrentInfo of [false, true]) {
    test(`${target.kind} info ${missingCurrentInfo ? "does not reuse older attempt paths" : "wraps long paths at the bottom of the page"}`, async ({
      page,
      context,
    }, testInfo) => {
      await context.setExtraHTTPHeaders({
        Authorization: `Bearer ${screenshotSessionToken}`,
      });
      await setScreenshotTime(page);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let detailQueriesValidated = 0;

      // Fetch the real response first: unknown sessionInfo schema fields or
      // resolver errors must fail before the browser-only edge fixtures apply.
      await page.route("**/api/graphql", async (route) => {
        const request = route.request().postDataJSON() as { query?: string };
        if (!request.query?.includes("query AgentRunDetail")) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as {
          errors?: unknown;
          data?: { agentRun?: AgentRunView | null };
        };
        expect(body.errors).toBeUndefined();
        const run = body.data?.agentRun;
        expect(run?.id).toBe(target.id);
        const baseAttempt = run!.attempts[0]!;
        expect(baseAttempt).toHaveProperty("sessionInfo");
        detailQueriesValidated += 1;
        run!.attempts = [
          {
            ...baseAttempt,
            id: "current-attempt",
            generation: 2,
            nativeId: CURRENT_NATIVE_ID,
            supersededAt: null,
            sessionInfo: missingCurrentInfo
              ? null
              : {
                  nativeTranscriptPath: LONG_TRANSCRIPT_PATH,
                  activityLogPath: "/aide/current-run/events.jsonl",
                  workingDirectory: "/workspaces/current-checkout",
                },
          },
          {
            ...baseAttempt,
            id: "older-attempt",
            generation: 1,
            nativeId: "older-native-session",
            supersededAt: null,
            sessionInfo: {
              nativeTranscriptPath: OLD_TRANSCRIPT_PATH,
              activityLogPath: "/old/events.jsonl",
              workingDirectory: "/old/checkout",
            },
          },
          {
            ...baseAttempt,
            id: "superseded-attempt",
            generation: 3,
            nativeId: "superseded-native-session",
            supersededAt: "2026-01-28T13:00:00.000Z",
            sessionInfo: {
              nativeTranscriptPath: "/superseded/session.jsonl",
            },
          },
        ];
        await route.fulfill({ response, json: body });
      });

      const response = await page.goto(`/en/ai/${target.kind}s/${target.id}`, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.ok()).toBe(true);
      const card = page.locator('main [data-slot="card"]').filter({
        has: page.getByText(target.title, { exact: true }),
      });
      await expect(card).toBeAttached();
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(async () => document.fonts.ready);

      await expect(infoRow(card, page, "Native session ID")).toContainText(
        CURRENT_NATIVE_ID,
      );
      await expect(card).not.toContainText("older-native-session");
      await expect(card).not.toContainText("superseded-native-session");
      await expect(card).not.toContainText(OLD_TRANSCRIPT_PATH);
      const lastCard = page.locator('main [data-slot="card"]').last();
      await expect(lastCard).toContainText(target.title);

      if (missingCurrentInfo) {
        for (const label of [
          "Native transcript path",
          "AIDE activity-log path",
          "Working directory",
        ]) {
          await expect(infoRow(card, page, label)).toContainText("Unavailable");
          await expect(
            card.getByRole("button", { name: `Copy ${label}`, exact: true }),
          ).toHaveCount(0);
        }
      } else {
        const path = card.getByText(LONG_TRANSCRIPT_PATH, { exact: true });
        await expect(path).toBeAttached();
        const bounds = await path.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            height: rect.height,
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(bounds.height).toBeGreaterThan(bounds.lineHeight * 2);
        const widths = await card.evaluate((element) => ({
          content: element.scrollWidth,
          available: element.clientWidth,
        }));
        expect(widths.content).toBeLessThanOrEqual(widths.available + 1);

        if (
          testInfo.project.name === "desktop-light" &&
          target.kind === "session"
        ) {
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          await card
            .getByRole("button", {
              name: "Copy Native transcript path",
              exact: true,
            })
            .click();
          await expect(card.getByText("Copied", { exact: true })).toBeVisible();
          expect(
            await page.evaluate(() => navigator.clipboard.readText()),
          ).toBe(LONG_TRANSCRIPT_PATH);
        }
      }

      // WebKit clips offscreen pixels inside the dashboard's scrolling main.
      // Keep the tested mobile width while giving the complete card room to
      // paint for its artifact; layout checks above use the real device height.
      const viewport = page.viewportSize()!;
      const cardBounds = await card.boundingBox();
      if (cardBounds && cardBounds.height > viewport.height - 100) {
        await page.setViewportSize({
          width: viewport.width,
          height: Math.ceil(cardBounds.height) + 160,
        });
        await card.scrollIntoViewIfNeeded();
      }
      const screenshotPath = testInfo.outputPath(`${target.kind}-info.png`);
      await card.screenshot({ path: screenshotPath, animations: "disabled" });
      await testInfo.attach(`${target.kind} info card`, {
        path: screenshotPath,
        contentType: "image/png",
      });
      expect(detailQueriesValidated).toBeGreaterThan(0);
      expect(pageErrors).toEqual([]);
    });
  }
}
