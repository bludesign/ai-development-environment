import { expect, test } from "@playwright/test";
import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";
import { stubWorktreeAgent } from "./worktree-stub";

const epoch = Date.parse("2026-01-28T12:00:00Z");
const chunk = (
  sequence: number,
  bytes = Buffer.from(`line-${sequence.toString().padStart(5, "0")}\n`),
) => ({
  id: `log-${sequence}`,
  scope: "BUILD",
  scopeId: String(ids.builds.archive),
  sequence,
  phase: "BUILD",
  stream: "STDOUT",
  dataBase64: bytes.toString("base64"),
  byteLength: bytes.length,
  createdAt: new Date(epoch + sequence).toISOString(),
});

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    Authorization: `Bearer ${screenshotSessionToken}`,
  });
});

test("terminal tails, prepends 6005 chunks, reconciles late output, and preserves UTF-8 and viewport", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-light",
    "One real xterm renderer exercises the buffer independently of theme.",
  );
  const chunks = Array.from({ length: 6005 }, (_, index) => chunk(index));
  const split = Buffer.from("split 🌍 last\n");
  chunks[6003] = chunk(6003, split.subarray(0, 8));
  chunks[6004] = chunk(6004, split.subarray(8));
  let fetchedOldest = 5005;
  let failOlder = true;
  let pushLive: ((value: ReturnType<typeof chunk>) => void) | undefined;
  await page.routeWebSocket(/graphql/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "connection_init")
        socket.send(JSON.stringify({ type: "connection_ack" }));
      if (
        message.type === "subscribe" &&
        message.payload.query.includes("BuildLogChunkAdded")
      ) {
        pushLive = (value) =>
          socket.send(
            JSON.stringify({
              id: message.id,
              type: "next",
              payload: { data: { buildLogChunkAdded: value } },
            }),
          );
      }
    });
  });
  await page.route("**/api/graphql", async (route) => {
    const { query, variables = {} } = route.request().postDataJSON();
    if (
      query.includes("query BuildLogChunks") &&
      query.includes("latest: true")
    )
      return route.fulfill({
        json: { data: { buildLogChunks: chunks.slice(-1000) } },
      });
    if (query.includes("query BuildOlderLogs")) {
      if (failOlder) {
        failOlder = false;
        return route.fulfill({
          json: {
            errors: [{ message: "Older output temporarily unavailable" }],
          },
        });
      }
      const before = chunks.findIndex((entry) => entry.id === variables.before);
      const older = chunks.slice(Math.max(0, before - 1000), before);
      fetchedOldest = Math.max(0, before - 1000);
      return route.fulfill({ json: { data: { buildLogChunks: older } } });
    }
    if (
      query.includes("query BuildReconcile") ||
      query.includes("query BuildLogChunks")
    ) {
      const known = variables.knownRanges ?? [];
      const missing = chunks.filter(
        (entry) =>
          !known.some(
            (range: {
              scope: string;
              scopeId: string;
              fromSequence: number;
              throughSequence: number;
            }) =>
              entry.scope === range.scope &&
              entry.scopeId === range.scopeId &&
              entry.sequence >= range.fromSequence &&
              entry.sequence <= range.throughSequence,
          ),
      );
      const response = await route.fetch();
      const json = await response.json();
      return route.fulfill({
        json: {
          ...json,
          data: { ...json.data, buildLogChunks: missing.slice(0, 1000) },
        },
      });
    }
    return route.fallback();
  });
  await page.goto(`/en/builds/${ids.builds.archive}`);
  const rows = page.locator(".xterm-rows").first();
  await expect(rows).toContainText("split 🌍 last");
  const scrollToStart = async () => {
    const track = page
      .locator(".xterm-scrollable-element > .scrollbar.vertical")
      .first();
    await page.locator(".xterm-screen").first().hover();
    const trackBox = (await track.boundingBox())!;
    const slider = (await track.locator(".slider").boundingBox())!;
    await page.mouse.move(
      slider.x + slider.width / 2,
      slider.y + slider.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width / 2, trackBox.y, {
      steps: 3,
    });
    await page.mouse.up();
  };
  await scrollToStart();
  await expect(
    page.getByText("Older output temporarily unavailable"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry earlier logs", exact: true })
    .click();
  await expect.poll(() => fetchedOldest).toBe(4005);
  await expect(rows).toContainText("line-05005");
  await expect(rows).not.toContainText("line-04005");
  await expect(rows).not.toContainText("── Build ──");
  const reading = await rows.innerText();
  await expect.poll(() => !!pushLive).toBe(true);
  const live = chunk(6005);
  chunks.push(live);
  pushLive!(live);
  pushLive!(live);
  await expect(rows).toHaveText(reading, { useInnerText: true });
  for (const expected of [3005, 2005, 1005, 5, 0]) {
    await scrollToStart();
    await expect.poll(() => fetchedOldest).toBe(expected);
    await expect(rows).toContainText(
      `line-${((expected === 0 ? 5 : expected + 1000) - 1).toString().padStart(5, "0")}`,
    );
  }
  await scrollToStart();
  await expect(rows).toContainText("line-00000");
  const rendered = await rows.innerText();
  expect(rendered.indexOf("line-00000")).toBeLessThan(
    rendered.indexOf("line-00001"),
  );
  // A missing earlier chunk arriving during recovery must replay before subsequent output.
  const late = {
    ...chunk(3006),
    id: "late",
    scope: "EXPORT",
    scopeId: "export-late",
    sequence: 3006,
    createdAt: new Date(epoch + 3005).toISOString(),
    dataBase64: Buffer.from("late-recovery\n").toString("base64"),
  };
  chunks.push(late);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("searchbox", { name: "Search terminal" })
    .fill("late-recovery");
  await expect(
    page.getByRole("button", { name: "Next match", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search terminal" })
    .fill("line-03000");
  await expect(rows).toContainText("late-recovery");
  const lateRows = await rows.innerText();
  expect(lateRows.indexOf("line-03005")).toBeLessThan(
    lateRows.indexOf("late-recovery"),
  );
  expect(lateRows.indexOf("late-recovery")).toBeLessThan(
    lateRows.indexOf("line-03006"),
  );
  await page.getByRole("searchbox", { name: "Search terminal" }).fill("");
  await page
    .getByRole("button", { name: "Follow output", exact: true })
    .click();
  await expect(rows).toContainText("line-06005");
  await expect(rows).toContainText("split 🌍 last");
  expect((await rows.innerText()).match(/line-06005/g)).toHaveLength(1);
  const live2 = chunk(6006);
  pushLive!(live2);
  await expect(rows).toContainText("line-06006");
});

test("install is accessible on desktop and does not open its build row", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"));
  await page.goto("/en/builds");
  const install = page
    .getByRole("button", { name: "Install", exact: true })
    .first();
  await expect(install).toHaveAttribute("aria-disabled", "true");
  await install.click({ force: true });
  await expect(
    page.getByText("Open this page on an iPhone or iPad to install.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/en\/builds$/);
});

test("custom build editor keeps the configuration selector available", async ({
  page,
}) => {
  await stubWorktreeAgent(page);
  await page.goto(`/en/worktrees/${ids.worktrees.iosMain}`);
  await page
    .getByRole("button", { name: "Build", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /Custom/ }).click();
  await expect(
    page.getByRole("heading", { name: "Custom build", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "Start Build", exact: true });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const custom = dialog.getByRole("button", { name: /^Custom / });
  const saved = dialog.getByRole("button", { name: /App Store Release/ });
  await expect(custom).toHaveAttribute("aria-pressed", "true");
  await expect(saved).toBeVisible();
  await saved.click();
  await expect(saved).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("region", { name: "Custom build" }),
  ).toHaveCount(0);
  await custom.click();
  const editor = dialog.getByRole("region", { name: "Custom build" });
  await editor.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /AcmeApp.xcworkspace/ }).click();
  await editor.getByRole("button", { name: "Use settings" }).click();
  await expect(custom).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("tab", { name: "Simulator", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start Build", exact: true }),
  ).toBeEnabled();
  await saved.click();
  await expect(saved).toHaveAttribute("aria-pressed", "true");
});

test("configuration details use breadcrumbs and show history without a lone tab", async ({
  page,
}, testInfo) => {
  await page.goto(
    `/en/builds/configurations/${ids.buildConfigurations.release}`,
  );
  await expect(
    page.getByRole("heading", { name: "App Store Release", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "History", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Build configurations", exact: true }),
  ).toHaveCount(0);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const configurations = breadcrumb.getByRole("link", {
    name: "Configurations",
    exact: true,
    includeHidden: true,
  });
  await expect(configurations).toHaveAttribute(
    "href",
    "/en/builds?view=configurations",
  );
  if (testInfo.project.name.startsWith("desktop")) {
    await configurations.click();
    await expect(
      page.getByRole("tab", { name: "Configurations", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page
        .getByRole("tabpanel", { name: "Configurations", exact: true })
        .getByRole("link", { name: /App Store Release/ }),
    ).toBeVisible();
  }
});

for (const device of ["iPhone", "iPad"] as const) {
  test(`install eligibility on ${device} respects export and metadata checks`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-light");
    await page.addInitScript((device) => {
      Object.defineProperty(navigator, "userAgent", {
        get: () =>
          device === "iPhone"
            ? "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15"
            : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      });
      Object.defineProperty(navigator, "platform", {
        get: () => (device === "iPhone" ? "iPhone" : "MacIntel"),
      });
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
    }, device);
    let metadata: Record<string, string> = {
      bundleIdentifier: "com.example.ios",
      exportMethod: "DEBUGGING",
    };
    await page.route("**/api/graphql", async (route) => {
      const { query } = route.request().postDataJSON();
      if (!query.includes("query BuildDetail")) return route.fallback();
      const response = await route.fetch();
      const json = await response.json();
      json.data.build.artifacts = [
        {
          id: "install-ipa",
          kind: "IPA",
          fileName: "App.ipa",
          relativePath: "App.ipa",
          mimeType: "application/octet-stream",
          byteSize: 100,
          metadata,
          createdAt: new Date(epoch).toISOString(),
        },
      ];
      return route.fulfill({ json });
    });
    await page.goto(`/en/builds/${ids.builds.archive}`);
    const install = page
      .getByRole("button", { name: "Install", exact: true })
      .first();
    await expect(install).toBeEnabled();
    await expect(install).not.toHaveAttribute("aria-disabled", "true");
    metadata = { ...metadata, exportMethod: "APP_STORE_CONNECT" };
    await page.reload();
    await expect(install).toHaveAttribute("aria-disabled", "true");
    await install.click({ force: true });
    await expect(
      page.getByText(
        "App Store Connect builds cannot be installed over the air. Export with Debugging, Release Testing, or Enterprise instead.",
        { exact: true },
      ),
    ).toBeVisible();
    metadata = { exportMethod: "DEBUGGING" };
    await page.reload();
    await expect(install).toHaveAttribute("aria-disabled", "true");
    await install.click({ force: true });
    await expect(
      page.getByText(/bundle identifier.*unavailable/i),
    ).toBeVisible();
  });
}

test("custom is selected automatically when a project has no configurations", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light");
  await stubWorktreeAgent(page);
  await page.route("**/api/graphql", async (route) => {
    const { query } = route.request().postDataJSON();
    if (!query.includes("query StartBuildProject")) return route.fallback();
    const response = await route.fetch();
    const json = await response.json();
    json.data.iosAppProject.configurations = [];
    return route.fulfill({ json });
  });
  await page.goto(`/en/worktrees/${ids.worktrees.iosMain}`);
  await page
    .getByRole("button", { name: "Build", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Custom build", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Custom / })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("install requires HTTPS in the app build list", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-light");
  await page.goto(`/en/apps/${ids.apps.mobileSuite}?view=builds`);
  const install = page
    .getByRole("button", { name: "Install", exact: true })
    .first();
  await expect(install).toHaveAttribute("aria-disabled", "true");
  await install.click({ force: true });
  await expect(
    page.getByText(/Over-the-air installation requires a public HTTPS address/),
  ).toBeVisible();
});
