import { describe, expect, test } from "vitest";

import { getConfigDescriptor } from "./descriptors";

describe("workflow config descriptors", () => {
  test("uses resource selectors for worktrees and Jira issue keys", () => {
    const runFields = getConfigDescriptor("RUN_CREATE_SESSION", "step")?.fields;

    expect(runFields?.find(({ key }) => key === "worktreeId")).toMatchObject({
      control: "resource",
      options: {
        kind: "resource",
        resource: "worktree",
        sessionPath: "worktree.id",
      },
    });
    expect(runFields?.find(({ key }) => key === "jiraIssueKey")).toMatchObject({
      control: "resource",
      options: {
        kind: "resource",
        resource: "jiraTicket",
        sessionPath: "ticket.key",
      },
    });
    expect(runFields?.find(({ key }) => key === "jiraSummary")).toBeUndefined();

    for (const kind of [
      "JIRA_LOAD_TICKET",
      "JIRA_TRANSITION",
      "JIRA_COMMENT",
      "JIRA_ASSIGN",
      "JIRA_UPDATE_FIELDS",
      "JIRA_RESOLVE_BRANCH",
    ]) {
      expect(
        getConfigDescriptor(kind, "step")?.fields.find(
          ({ key }) => key === "issueKey",
        ),
      ).toMatchObject({
        control: "resource",
        options: { kind: "resource", resource: "jiraTicket" },
      });
    }
  });
});
