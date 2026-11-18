import { expect, test, type APIRequestContext } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { setScreenshotTime } from "./screenshot-time";

const keys = [
  "includePlans",
  "includeSessions",
  "includeBuilds",
  "includeWorkflows",
  "includeCommands",
  "includeGitHubActions",
  "includeGitLabPipelines",
] as const;

type Settings = Record<(typeof keys)[number], boolean>;
const headers = { Authorization: `Bearer ${screenshotSessionToken}` };

async function settingsRequest(
  request: APIRequestContext,
  input?: Partial<Settings>,
): Promise<Settings> {
  const response = await request.post("/api/graphql", {
    headers,
    data: input
      ? {
          query: `mutation SaveTestLiveActivitySettings($input: SaveLiveActivitySettingsInput!) {
            saveLiveActivitySettings(input: $input) { ${keys.join(" ")} }
          }`,
          variables: { input },
        }
      : {
          query: `query { liveActivitySettings { ${keys.join(" ")} } }`,
        },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  return input
    ? body.data.saveLiveActivitySettings
    : body.data.liveActivitySettings;
}

test("Live Activity choices persist and attention alone does not keep the activity active", async ({
  page,
  request,
}) => {
  const original = await settingsRequest(request);
  try {
    await settingsRequest(
      request,
      Object.fromEntries(keys.map((key) => [key, true])),
    );
    await page.setExtraHTTPHeaders(headers);
    await setScreenshotTime(page);
    await page.goto("/en/dashboard/notifications");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    const actions = page.getByRole("switch", {
      name: "GitHub Actions runs",
      exact: true,
    });
    await expect(actions).toBeChecked();
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/graphql") &&
          response
            .request()
            .postData()
            ?.includes("mutation SaveLiveActivitySettings") === true,
      ),
      actions.click(),
    ]);
    expect((await saved.json()).errors).toBeUndefined();
    await expect(actions).toBeEnabled();
    await expect(actions).not.toBeChecked();
    expect(await settingsRequest(request)).toEqual({
      ...Object.fromEntries(keys.map((key) => [key, true])),
      includeGitHubActions: false,
    });

    await page.reload();
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(actions).not.toBeChecked();

    await settingsRequest(
      request,
      Object.fromEntries(keys.map((key) => [key, false])),
    );
    const response = await request.get("/api/ios/status", { headers });
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    expect(snapshot.liveActivity.activeCount).toBe(0);
    expect(snapshot.liveActivity.needsAttentionCount).toBeGreaterThan(0);
    expect(snapshot.liveActivity.needsAttentionCount).toBe(
      snapshot.actionCenter.needsAttentionCount,
    );
  } finally {
    await settingsRequest(request, original);
  }
});
