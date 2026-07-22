import { describe, expect, test } from "vitest";

import { parseJiraIssueKey } from "./jira-issue-key";

describe("parseJiraIssueKey", () => {
  test.each([
    ["app-123", "APP-123"],
    [" https://example.atlassian.net/browse/APP-123?atlOrigin=abc ", "APP-123"],
    [
      "https://example.atlassian.net/jira/software/c/projects/APP/issues/app-456",
      "APP-456",
    ],
    [
      "https://example.atlassian.net/jira/software/c/projects/APP/boards/1?selectedIssue=APP-789",
      "APP-789",
    ],
  ])("parses %s", (value, expected) => {
    expect(parseJiraIssueKey(value)).toBe(expected);
  });

  test.each([
    "",
    "not-a-ticket",
    "https://example.atlassian.net/browse/",
    "https://example.atlassian.net/browse/not-a-ticket",
  ])("rejects %s", (value) => {
    expect(parseJiraIssueKey(value)).toBeNull();
  });
});
