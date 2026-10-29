import { describe, expect, test } from "vitest";

import {
  applicableCodeowners,
  ownershipPathMatches,
  parseCodeowners,
  reviewerRuleApplies,
} from "./codeowners";

describe("CODEOWNERS provider syntax", () => {
  test("GitHub uses the final matching entry and honors ownerless overrides", () => {
    const entries = parseCodeowners(
      `* @default\n/apps/ @org/team @alice\n/apps/generated/\n!ignored @wrong\n[range] @wrong\n*.js @js # @not-an-owner`,
      "GITHUB",
    );
    expect(
      applicableCodeowners(entries, [
        "apps/main.swift",
        "apps/generated/file.swift",
        "src/app.js",
      ]).map((entry) => entry.owners),
    ).toEqual([["@org/team", "@alice"], ["@js"]]);
    expect(entries).toHaveLength(4);
  });

  test("GitLab sections retain independent owners, defaults, roles, and permanent exclusions", () => {
    const entries = parseCodeowners(
      `* @general\n[Docs][2] @docs\ndocs/\nREADME.md @@maintainers\n!docs/generated/\ndocs/generated/manual.md @cannot-reinclude\n^[Optional] @other\nother/`,
      "GITLAB",
    );
    const matching = applicableCodeowners(entries, [
      "docs/generated/manual.md",
      "docs/guide.md",
      "README.md",
      "other/file",
    ]);
    expect(
      matching.map((entry) => [entry.section, entry.pattern, entry.owners]),
    ).toEqual([
      ["codeowners", "*", ["@general"]],
      ["docs", "docs/", ["@docs"]],
      ["docs", "README.md", ["@@maintainers"]],
      ["optional", "other/", ["@other"]],
    ]);
    expect(
      matching.find((entry) => entry.pattern === "docs/")?.approvalsRequired,
    ).toBe(2);
    expect(
      matching.find((entry) => entry.section === "optional")?.optional,
    ).toBe(true);
  });

  test("duplicate GitLab section names are case insensitive and required wins", () => {
    const entries = parseCodeowners(
      "^[Docs] @one\na/\n[DOCS] @two\nb/",
      "GITLAB",
    );
    expect(
      entries.map((entry) => [entry.section, entry.optional, entry.owners]),
    ).toEqual([
      ["docs", false, ["@one"]],
      ["docs", false, ["@two"]],
    ]);
  });

  test.each([
    ["*.js", "src/app.js", true],
    ["docs/*", "docs/guide.md", true],
    ["docs/*", "docs/nested/guide.md", false],
    ["/docs/", "docs/nested/guide.md", true],
    ["/docs/", "other/docs/guide.md", false],
    ["**/logs/", "deep/logs/build.log", true],
    ["/root\\ folder/", "root folder/file", true],
    ["**/*.rb", "root.rb", true],
    ["**/*.rb", ".hidden/deep/file.rb", true],
  ])("matches %s against %s", (pattern, path, expected) => {
    expect(ownershipPathMatches(pattern, path)).toBe(expected);
  });

  test("ruleset file patterns support ordered negation and character classes", () => {
    const patterns = [
      "src/**",
      "!src/generated/**",
      "src/generated/critical[0-9].ts",
    ];
    expect(reviewerRuleApplies(patterns, ["src/generated/other.ts"])).toBe(
      false,
    );
    expect(reviewerRuleApplies(patterns, ["src/generated/critical2.ts"])).toBe(
      true,
    );
    expect(reviewerRuleApplies(patterns, ["src/.hidden.ts"])).toBe(true);
  });
});
