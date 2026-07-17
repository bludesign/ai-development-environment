import { describe, expect, test } from "vitest";

import {
  DEFAULT_JIRA_BRANCH_NAMING_SCRIPT,
  jiraBranchCandidates,
  validateJiraBranchNamingScript,
} from "./branch-naming";

describe("Jira branch naming", () => {
  test("uses feature and bugfix defaults with incrementing collisions", async () => {
    const feature = await jiraBranchCandidates(
      DEFAULT_JIRA_BRANCH_NAMING_SCRIPT,
      {
        ticketKey: "APP-123",
        type: "Story",
        title: "Résumé: Add Search!",
      },
    );
    expect(feature.slice(0, 3)).toEqual([
      "feature/APP-123-resume-add-search",
      "feature/APP-123-resume-add-search-2",
      "feature/APP-123-resume-add-search-3",
    ]);
    expect(
      (
        await jiraBranchCandidates(DEFAULT_JIRA_BRANCH_NAMING_SCRIPT, {
          ticketKey: "APP-124",
          type: "BUG",
          title: "Broken login",
        })
      )[0],
    ).toBe("bugfix/APP-124-broken-login");
  });

  test("supports the object signature and rejects non-progressing scripts", async () => {
    expect(
      await validateJiraBranchNamingScript(
        `({ ticketKey, alreadyTaken }) => ticketKey + "-" + (alreadyTaken ? Number(alreadyTaken.split("-").at(-1)) + 1 : 1)`,
        "APP",
      ),
    ).toContain("ticketKey");
    await expect(
      validateJiraBranchNamingScript(`({ ticketKey }) => ticketKey`, "APP"),
    ).rejects.toThrow("must return a new name");
  });

  test("times out runaway functions", async () => {
    await expect(
      validateJiraBranchNamingScript(`() => { while (true) {} }`, "APP"),
    ).rejects.toThrow("timed out");
  });

  test("does not expose host constructors to naming functions", async () => {
    await expect(
      jiraBranchCandidates(
        `() => "feature/" + input.constructor.constructor("return process")().version`,
        {
          ticketKey: "APP-123",
          type: "Story",
          title: "Host escape",
        },
      ),
    ).rejects.toThrow(/process.*not defined/);
  });
});
