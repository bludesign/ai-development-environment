import { describe, expect, test } from "vitest";

import { eligiblePortalDeviceIds } from "./apple-portal";

const devices = [
  {
    id: "ios-enabled",
    type: "devices",
    attributes: { status: "ENABLED", platform: "IOS" },
  },
  {
    id: "ios-disabled",
    type: "devices",
    attributes: { status: "DISABLED", platform: "IOS" },
  },
  {
    id: "mac-enabled",
    type: "devices",
    attributes: { status: "ENABLED", platform: "MAC_OS" },
  },
  {
    id: "tvos-enabled",
    type: "devices",
    attributes: { status: "ENABLED", platform: "TV_OS" },
  },
];

describe("eligiblePortalDeviceIds", () => {
  test.each(["IOS_APP_DEVELOPMENT", "IOS_APP_ADHOC"])(
    "uses only enabled iOS devices for %s profiles",
    (profileType) => {
      expect(eligiblePortalDeviceIds(devices, profileType)).toEqual([
        "ios-enabled",
      ]);
    },
  );

  test("does not attach devices to App Store profiles", () => {
    expect(eligiblePortalDeviceIds(devices, "IOS_APP_STORE")).toEqual([]);
  });
});
