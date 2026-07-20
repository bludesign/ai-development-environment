// @vitest-environment node
import { describe, expect, test } from "vitest";

import { normalizeUdid } from "./ios-devices.service";

describe("normalizeUdid", () => {
  test("trims and uppercases legacy and modern device identifiers", () => {
    expect(normalizeUdid(" 00008030-001c2d3e4f50002e ")).toBe(
      "00008030-001C2D3E4F50002E",
    );
    expect(normalizeUdid("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456789ABCDEF0123456789ABCDEF01234567",
    );
  });

  test.each([
    "",
    "short",
    "not-a-valid-device-identifier!",
    "-------------------------",
    "00008030-001C2D3E4F50002EFFFF",
    null,
  ])("rejects malformed UDID value %s", (value) => {
    expect(() => normalizeUdid(value)).toThrow();
  });
});
