import { expect, test, type Locator, type Page } from "@playwright/test";

import { INTERACTIVE_SELECTOR } from "../src/components/worktrees/worktree-navigation";
import {
  MOBILE_BREAKPOINT,
  WALKTHROUGH_START,
  WALKTHROUGH_STOPS,
  localeHref,
  markClicks,
  walkthroughVideoSize,
  type WalkthroughStop,
} from "./walkthrough";

/** How long a click's marker dot is left to play out before the tour moves on. */
const DWELL = 750;

/** How long a settled page holds still before the next click. */
const HOLD = 800;

/**
 * Records one screencast per project of a click-through of the app — Action Center, Worktrees,
 * a worktree's detail page, Sessions, and back to where it started — for the docs landing page
 * to use in place of a single still.
 *
 * Video is switched on here rather than in the config so the route captures in
 * `capture.spec.ts` stay screenshot-only. Playwright's own `show` overlay is deliberately left
 * off; `markClicks` draws the click markers instead, for the reasons documented alongside it.
 * The size comes off the project's own `viewport` rather than the fixture of the same name,
 * because `video` is worker-scoped and cannot depend on a per-test fixture.
 */
test.use({
  video: async ({}, use, workerInfo) => {
    await use({
      mode: "on",
      size: walkthroughVideoSize(workerInfo.project.use.viewport ?? null),
    });
  },
});

type Tour = {
  page: Page;
  /**
   * True below `MOBILE_BREAKPOINT`, where the primary navigation is a sheet behind the header's
   * toggle rather than a standing sidebar, and taps replace the pointer entirely.
   */
  compact: boolean;
};

// A tour is several pages long, so it needs more than the per-route timeout in the config.
test.describe.configure({ timeout: 180_000 });

test.describe("app walkthrough", () => {
  test("walkthrough", async ({ page }, testInfo) => {
    // Uncaught exceptions and unhandled rejections. Collected rather than thrown from the
    // listener so they surface as an assertion once the video is safely on disk.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const tour: Tour = {
      page,
      compact:
        (page.viewportSize()?.width ?? MOBILE_BREAKPOINT) < MOBILE_BREAKPOINT,
    };

    try {
      await page.addInitScript(markClicks);
      await page.goto(localeHref(WALKTHROUGH_START), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await settle(page);
      await page.waitForTimeout(HOLD);

      for (const stop of WALKTHROUGH_STOPS) {
        await test.step(stop.name, () => visit(tour, stop));
      }
    } finally {
      // The video is only written out once the page closes, so a failed run still leaves a
      // recording to diagnose from — the same reason capture.spec.ts screenshots before it
      // asserts.
      if (!page.isClosed()) await page.close();
      await page
        .video()
        ?.saveAs(`screenshots/${testInfo.project.name}/walkthrough.webm`);
    }

    expect(pageErrors, "the walkthrough raised uncaught page errors").toEqual(
      [],
    );
  });
});

/** Clicks through to a stop, then holds it long enough to read. */
async function visit(tour: Tour, stop: WalkthroughStop): Promise<void> {
  const href = localeHref(stop.path);
  if (stop.via === "nav") {
    await press(tour, await openNavigation(tour, href));
  } else {
    await pressCard(tour, href);
  }
  await tour.page.waitForTimeout(DWELL);

  // `/en` is also a prefix of every other stop, so the match has to be anchored. This is also
  // what catches a card whose plain surface has stopped being plain: the click lands on
  // something that swallows it, nothing navigates, and the tour fails rather than filming the
  // wrong page.
  await expect(tour.page).toHaveURL(new RegExp(`${escapeForRegExp(href)}$`));
  await settle(tour.page);
  await tour.page.waitForTimeout(HOLD);
}

/**
 * Resolves the primary navigation entry for an href, opening the sheet first on compact
 * viewports. Scoping to `sidebar-menu-button` keeps this off the notifications rail, which is
 * also a `[data-slot="sidebar"]` and links to some of the same places.
 */
async function openNavigation(tour: Tour, href: string): Promise<Locator> {
  const entry = tour.page.locator(
    `a[data-slot="sidebar-menu-button"][href="${href}"]`,
  );
  if (!tour.compact) return entry;

  // Both sidebar toggles carry aria-expanded; the navigation one comes first in the header.
  const toggle = tour.page.locator("header button[aria-expanded]").first();
  await press(tour, toggle);
  await entry.waitFor({ state: "visible" });
  await tour.page.waitForTimeout(300);
  return entry;
}

/**
 * Clicks the worktree card that owns a detail href — the card is identified by the link to that
 * page it contains — on a part of it that navigates.
 *
 * A card carries the reader to its detail page when any plain part of its surface is clicked,
 * but which parts are plain depends on how it has wrapped: the desktop layout leaves its middle
 * clear, while the narrow one stacks controls straight through the centre. So rather than assume
 * a point, this asks the page, applying the same `INTERACTIVE_SELECTOR` rule the card's own
 * handler does, and sweeps outward from the middle so the click lands as close to centre as the
 * layout allows.
 */
async function pressCard(tour: Tour, href: string): Promise<void> {
  const card = tour.page
    .locator('main [data-slot="card"]')
    .filter({ has: tour.page.locator(`a[href="${href}"]`) })
    .first();
  await card.scrollIntoViewIfNeeded();

  const position = await card.evaluate((node, interactive) => {
    const rect = node.getBoundingClientRect();
    for (const down of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
      for (const across of [0.5, 0.3, 0.7]) {
        const element = document.elementFromPoint(
          rect.left + rect.width * across,
          rect.top + rect.height * down,
        );
        if (!element || !node.contains(element)) continue;
        if (element.closest(interactive)) continue;
        return { x: rect.width * across, y: rect.height * down };
      }
    }
    return null;
  }, INTERACTIVE_SELECTOR);

  expect(
    position,
    `no part of the ${href} card's surface navigates; every candidate point is interactive`,
  ).not.toBeNull();

  if (tour.compact) {
    await card.tap({ position: position! });
    return;
  }
  await card.click({ position: position! });
  await tour.page.mouse.move(1, 1);
}

/**
 * Clicks a target, or taps it on a touch viewport.
 *
 * Afterwards the pointer is parked out of the way. It would otherwise be left resting wherever
 * it clicked, and on the page that loads next that lands on a timestamp whose tooltip then
 * opens over the recording.
 */
async function press(tour: Tour, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  if (tour.compact) {
    await target.tap();
    return;
  }
  await target.click();
  await tour.page.mouse.move(1, 1);
}

/**
 * Waits for a stop to be worth filming. The route captures can afford a long lean on
 * `networkidle`, but a tour pays that cost at every stop, and on these pages it fires before
 * the GraphQL data lands anyway — long enough to film a table still saying "Loading". So this
 * waits on the app's own two signals instead: the heading, which means the page rendered, and
 * the absence of the shared Spinner, which every loading state in the app renders.
 *
 * Both are lenient, and the spinner budget is deliberately short: the worktree pages keep a
 * spinner mounted indefinitely, so waiting it out would add dead air to every recording. A stop
 * that never quiets down is still filmed, and a genuinely broken one is caught by the URL and
 * page-error assertions rather than by a timeout here.
 */
async function settle(page: Page): Promise<void> {
  const main = page.locator("main");
  await main
    .locator("h1")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});
  await expect(main.locator('[data-slot="spinner"]'))
    .toHaveCount(0, { timeout: 1_500 })
    .catch(() => {});
  await page.waitForTimeout(400);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
