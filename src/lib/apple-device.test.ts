import { describe, expect, test } from "vitest";

import { formatAppleOsVersion, formatAppleProductName } from "./apple-device";

describe("formatAppleProductName", () => {
  test("names known hardware identifiers", () => {
    expect(formatAppleProductName("iPhone16,2")).toBe("iPhone 15 Pro Max");
    expect(formatAppleProductName("iPhone12,1")).toBe("iPhone 11");
    expect(formatAppleProductName("iPad14,1")).toBe(
      "iPad mini (6th generation)",
    );
  });

  test("labels simulator architectures", () => {
    expect(formatAppleProductName("arm64")).toBe("Simulator (arm64)");
  });

  test("keeps identifiers the table does not cover", () => {
    expect(formatAppleProductName("iPhone99,9")).toBe("iPhone99,9");
    expect(formatAppleProductName("")).toBe("");
  });
});

describe("formatAppleOsVersion", () => {
  test("reads build numbers as marketing versions", () => {
    expect(formatAppleOsVersion("23F84")).toBe("26.5");
    expect(formatAppleOsVersion("23A340")).toBe("26.0");
    expect(formatAppleOsVersion("22B83")).toBe("18.1");
    expect(formatAppleOsVersion("21A329")).toBe("17.0");
  });

  test("reads beta build suffixes", () => {
    expect(formatAppleOsVersion("23A5297f")).toBe("26.0");
  });

  test("drops the platform prefix from versions Apple already spells out", () => {
    expect(formatAppleOsVersion("iOS 18.5")).toBe("18.5");
    expect(formatAppleOsVersion("iPadOS 18.5")).toBe("18.5");
    expect(formatAppleOsVersion("19.0")).toBe("19.0");
    expect(formatAppleOsVersion("")).toBe("");
  });
});
