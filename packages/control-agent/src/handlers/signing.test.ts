import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { certificateFingerprints } from "./signing.js";

const DER = Buffer.from("a pretend DER encoded certificate");
const SHA1 = createHash("sha1").update(DER).digest("hex").toUpperCase();

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
