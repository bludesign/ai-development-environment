import { describe, expect, test } from "vitest";

import {
  compareSkillVersions,
  hasDivergentTargetVersions,
  selectSharedSkillRoots,
} from "./sync-direction";

describe("compareSkillVersions", () => {
  test("uses the last common hash to choose a direction", () => {
    expect(
      compareSkillVersions({
        databaseHash: "base",
        targetHash: "target-change",
        baselineHash: "base",
        tracked: false,
      }),
    ).toBe("IMPORT");
    expect(
      compareSkillVersions({
        databaseHash: "database-change",
        targetHash: "base",
        baselineHash: "base",
        tracked: false,
      }),
    ).toBe("EXPORT");
  });

  test("blocks unknown divergence and tracked changes", () => {
    expect(
      compareSkillVersions({
        databaseHash: "database-change",
        targetHash: "target-change",
        baselineHash: "base",
        tracked: false,
      }),
    ).toBe("CONFLICT");
    expect(
      compareSkillVersions({
        databaseHash: "database-change",
        targetHash: "base",
        baselineHash: "base",
        tracked: true,
      }),
    ).toBe("CONFLICT");
  });
});

describe("hasDivergentTargetVersions", () => {
  test("allows one changed target version alongside unchanged copies", () => {
    expect(
      hasDivergentTargetVersions("base", ["base", "target-change", "base"]),
    ).toBe(false);
  });

  test("blocks multiple independently changed target versions", () => {
    expect(
      hasDivergentTargetVersions("base", ["first-change", "second-change"]),
    ).toBe(true);
    expect(hasDivergentTargetVersions(null, ["first", "second"])).toBe(true);
  });
});

describe("selectSharedSkillRoots", () => {
  test("uses Claude as the shared project root when it covers every client", () => {
    expect(
      selectSharedSkillRoots(["CLAUDE", "CURSOR", "GITHUB_COPILOT"], "PROJECT"),
    ).toEqual(["CLAUDE"]);
  });

  test("adds the Agents root when a global client cannot read Claude skills", () => {
    expect(
      selectSharedSkillRoots(["CLAUDE", "GITHUB_COPILOT"], "GLOBAL"),
    ).toEqual(["CLAUDE", "AGENTS"]);
    expect(selectSharedSkillRoots(["CLAUDE", "CODEX"], "PROJECT")).toEqual([
      "CLAUDE",
      "AGENTS",
    ]);
  });

  test("uses Agents for enabled non-Claude clients", () => {
    expect(selectSharedSkillRoots(["CURSOR", "OPENCODE"], "GLOBAL")).toEqual([
      "AGENTS",
    ]);
    expect(selectSharedSkillRoots([], "PROJECT")).toEqual([]);
  });
});
