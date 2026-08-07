import { describe, expect, test } from "vitest";

import {
  APP_DESTINATIONS,
  destinationVisible,
  type NavigationFeatures,
} from "./app-destinations";

describe("app destinations", () => {
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
});
