import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";

import {
  APP_DESTINATIONS,
  destinationVisible,
  type NavigationFeatures,
} from "./app-destinations";

describe("app destinations", () => {
  test("every destination resolves to a page under its navigation section", () => {
    for (const destination of APP_DESTINATIONS) {
      expect(destination.href, destination.key).toMatch(
        new RegExp(`^/${destination.section}/`),
      );
      expect(
        existsSync(`src/app/[locale]/(dashboard)${destination.href}/page.tsx`),
        destination.href,
      ).toBe(true);
    }
  });

  test("keeps GitHub App-only webhook navigation visible", () => {
    const destination = APP_DESTINATIONS.find(({ key }) => key === "webhooks");
    expect(destination).toBeDefined();
    const features: NavigationFeatures = {
      actionsCache: false,
      jiraWebhooks: false,
      webhooks: true,
      github: false,
      gitlab: false,
      gitlabWebhooks: false,
    };
    expect(destinationVisible(destination!, features)).toBe(true);
  });

  test("includes Tailscale under System", () => {
    expect(APP_DESTINATIONS).toContainEqual(
      expect.objectContaining({
        key: "tailscale",
        href: "/system/tailscale",
        section: "system",
        sidebar: true,
      }),
    );
  });
});
