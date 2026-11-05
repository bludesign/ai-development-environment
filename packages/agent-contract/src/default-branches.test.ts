import { describe, expect, test } from "vitest";
import {
  isDefaultBranch,
  normalizeDefaultBranchPatterns,
  parseDefaultBranchPatterns,
  codebaseJobPayload,
} from "./codebases";

describe("default branch matching", () => {
  test("always includes the remote default and matches full case-sensitive names", () => {
    expect(isDefaultBranch("main", "main", ["release/*"])).toBe(true);
    expect(isDefaultBranch("release/2026/hotfix", "main", ["release/*"])).toBe(
      true,
    );
    expect(isDefaultBranch("develop", "main", ["develop"])).toBe(true);
    expect(isDefaultBranch("feature/develop", "main", ["develop"])).toBe(false);
    expect(isDefaultBranch("Release/1", "main", ["release/*"])).toBe(false);
    expect(isDefaultBranch(null, "main", ["*"])).toBe(false);
    expect(isDefaultBranch("a.b", null, ["a.b"])).toBe(true);
    expect(isDefaultBranch("axb", null, ["a.b"])).toBe(false);
  });
  test("normalizes settings and validates agent payloads", () => {
    expect(
      normalizeDefaultBranchPatterns([" develop ", "", "develop", "release/*"]),
    ).toEqual(["develop", "release/*"]);
    expect(() => normalizeDefaultBranchPatterns(["bad branch"])).toThrow();
    expect(() => normalizeDefaultBranchPatterns([false])).toThrow();
    expect(parseDefaultBranchPatterns("invalid")).toEqual([]);
    expect(
      codebaseJobPayload({
        folder: "/repo",
        defaultBranchPatterns: ["release/*"],
      }).defaultBranchPatterns,
    ).toEqual(["release/*"]);
  });
});
