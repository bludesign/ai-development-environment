// @vitest-environment node
import { parsePlist } from "@ai-development-environment/agent-contract/plist";
import { describe, expect, test } from "vitest";

import { enrollmentProfileXml } from "./ios-devices.service";

describe("enrollmentProfileXml", () => {
  test("uses a fixed identity, unique UUIDs, escaped values, and only approved attributes", () => {
    const input = {
      token: "abc_123-token",
      publicOrigin: "https://devices.example.com",
      organizationName: "Research & Development <Team>",
      profileIdentifier: "com.example.device-enrollment",
    };
    const firstXml = enrollmentProfileXml(input);
    const secondXml = enrollmentProfileXml(input);
    const first = parsePlist(firstXml) as Record<string, unknown>;
    const second = parsePlist(secondXml) as Record<string, unknown>;
    const payload = first.PayloadContent as Record<string, unknown>;

    expect(first.PayloadIdentifier).toBe("com.example.device-enrollment");
    expect(first.PayloadUUID).not.toBe(second.PayloadUUID);
    expect(first.PayloadOrganization).toBe("Research & Development <Team>");
    expect(firstXml).toContain("Research &amp; Development &lt;Team&gt;");
    expect(payload.URL).toBe(
      "https://devices.example.com/api/public/ios/profile-response?token=abc_123-token",
    );
    expect(payload.Challenge).toBe("abc_123-token");
    expect(payload.DeviceAttributes).toEqual(["UDID", "PRODUCT", "VERSION"]);
  });
});
