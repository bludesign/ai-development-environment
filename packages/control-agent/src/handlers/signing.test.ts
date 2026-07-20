import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { SigningProfile } from "@ai-development-environment/agent-contract/builds";

import {
  certificateFingerprints,
  dedupeProfiles,
  scanSigningAssets,
} from "./signing.js";

const DER = Buffer.from("a pretend DER encoded certificate");
const SHA1 = createHash("sha1").update(DER).digest("hex").toUpperCase();

function profile(
  uuid: string,
  certificateSha1s: string[],
  expiresAt = "2027-01-01T00:00:00.000Z",
): SigningProfile {
  return {
    uuid,
    name: "Development",
    teamId: "TEAM123456",
    teamName: "Example Team",
    bundleId: "com.example.app",
    type: "DEVELOPMENT",
    platforms: ["iOS"],
    expiresAt,
    expired: false,
    xcodeManaged: false,
    certificateSha1s,
  };
}

describe("certificateFingerprints", () => {
  test("matches the fingerprint security find-identity reports", () => {
    expect(certificateFingerprints([DER.toString("base64")])).toEqual([SHA1]);
  });

  test("tolerates the line wrapping XML plists apply to data", () => {
    const wrapped = DER.toString("base64").replace(/(.{8})/g, "$1\n\t");
    expect(certificateFingerprints([wrapped])).toEqual([SHA1]);
  });

  test("reads every certificate in a profile", () => {
    const other = Buffer.from("second certificate");
    expect(
      certificateFingerprints([
        DER.toString("base64"),
        other.toString("base64"),
      ]),
    ).toEqual([
      SHA1,
      createHash("sha1").update(other).digest("hex").toUpperCase(),
    ]);
  });

  test("returns nothing when the profile carries no certificates", () => {
    expect(certificateFingerprints(undefined)).toEqual([]);
    expect(certificateFingerprints([])).toEqual([]);
  });

  test("skips entries that are not usable base64", () => {
    expect(certificateFingerprints([""])).toEqual([]);
  });
});

describe("dedupeProfiles", () => {
  test("preserves otherwise-identical profiles with different certificates", () => {
    const profiles = dedupeProfiles([
      profile("profile-a", ["A".repeat(40)]),
      profile("profile-b", ["B".repeat(40)], "2028-01-01T00:00:00.000Z"),
    ]);

    expect(profiles.map(({ uuid }) => uuid)).toEqual([
      "profile-a",
      "profile-b",
    ]);
  });

  test("treats certificate fingerprints as an unordered set", () => {
    const profiles = dedupeProfiles([
      profile("older", ["B".repeat(40), "A".repeat(40)]),
      profile(
        "newer",
        ["A".repeat(40), "B".repeat(40)],
        "2028-01-01T00:00:00.000Z",
      ),
    ]);

    expect(profiles.map(({ uuid }) => uuid)).toEqual(["newer"]);
  });
});

describe("scanSigningAssets", () => {
  test("fails a cancelled scan instead of returning an empty inventory", async () => {
    await expect(
      scanSigningAssets({}, 10_000, AbortSignal.abort(), async () => undefined),
    ).rejects.toThrow();
  });
});
