import {
  jiraBranchNameCandidates,
  renderJiraBranchPrompt,
  validateJiraBranchPrompt,
  validGitBranchName,
} from "@ai-development-environment/agent-contract/worktrees";
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

describe("AI branch prompts and collisions", () => {
  test("expands only supported tokens once and preserves ticket text literally", () => {
    expect(
      renderJiraBranchPrompt(
        "{{ticket.key}}: {{ ticket.title }} / {{ticket.description}}",
        {
          key: "APP-1",
          type: "Story",
          title: "{{ticket.description}} $&",
          description: "",
        },
      ),
    ).toBe("APP-1: {{ticket.description}} $& / ");
    expect(() => validateJiraBranchPrompt("{{ticket.password}}")).toThrow(
      "Unsupported",
    );
    expect(() => validateJiraBranchPrompt("{{ticket.key")).toThrow("syntax");
  });
  test("validates output and creates 100 unique valid candidates at the Git length limit", () => {
    const candidates = jiraBranchNameCandidates("feature/" + "a".repeat(247));
    expect(candidates).toHaveLength(100);
    expect(new Set(candidates).size).toBe(100);
    expect(candidates.every(validGitBranchName)).toBe(true);
    expect(candidates[99]).toMatch(/-100$/);
    expect(() => jiraBranchNameCandidates("Here is a branch")).toThrow(
      "Invalid",
    );
    expect(() => jiraBranchNameCandidates("```\nfeature/APP-1\n```")).toThrow(
      "Invalid",
    );
  });
});
