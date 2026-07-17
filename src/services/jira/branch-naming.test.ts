import { describe, expect, test } from "vitest";

import {
  DEFAULT_JIRA_BRANCH_NAMING_SCRIPT,
  jiraBranchCandidates,
  validateJiraBranchNamingScript,
} from "./branch-naming";

describe("Jira branch naming", () => {
  test("uses feature and bugfix defaults with incrementing collisions", () => {
    const feature = jiraBranchCandidates(DEFAULT_JIRA_BRANCH_NAMING_SCRIPT, {
      ticketKey: "APP-123",
      type: "Story",
      title: "Résumé: Add Search!",
    });
    expect(feature.slice(0, 3)).toEqual([
      "feature/APP-123-resume-add-search",
      "feature/APP-123-resume-add-search-2",
      "feature/APP-123-resume-add-search-3",
    ]);
    expect(
      jiraBranchCandidates(DEFAULT_JIRA_BRANCH_NAMING_SCRIPT, {
        ticketKey: "APP-124",
        type: "BUG",
        title: "Broken login",
      })[0],
    ).toBe("bugfix/APP-124-broken-login");
  });

  test("supports the object signature and rejects non-progressing scripts", () => {
    expect(
      validateJiraBranchNamingScript(
        `({ ticketKey, alreadyTaken }) => ticketKey + "-" + (alreadyTaken ? Number(alreadyTaken.split("-").at(-1)) + 1 : 1)`,
        "APP",
      ),
    ).toContain("ticketKey");
    expect(() =>
      validateJiraBranchNamingScript(`({ ticketKey }) => ticketKey`, "APP"),
    ).toThrow("must return a new name");
  });

  test("times out runaway functions", () => {
    expect(() =>
      validateJiraBranchNamingScript(`() => { while (true) {} }`, "APP"),
    ).toThrow("timed out");
  });
});
