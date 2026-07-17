import { describe, expect, test } from "vitest";

import {
  detectJiraTextFormat,
  jiraWikiToMarkdown,
  markdownToJiraWiki,
  rawJiraText,
  stripAdfMarkdownMetadata,
} from "./jira-markup";

describe("Jira markup helpers", () => {
  test("detects only unambiguous Wiki syntax and defaults ambiguous text to Markdown", () => {
    expect(detectJiraTextFormat("h2. Deployment plan")).toBe("JIRA_WIKI");
    expect(detectJiraTextFormat("{code:typescript}\nrun();\n{code}")).toBe(
      "JIRA_WIKI",
    );
    expect(detectJiraTextFormat("*important*")).toBe("MARKDOWN");
    expect(detectJiraTextFormat("## Deployment plan")).toBe("MARKDOWN");
  });

  test("converts Jira Wiki headings, formatting, references, lists, and tables", () => {
    const markdown = jiraWikiToMarkdown(
      "h2. Release\n\n*Owner:* [~chandler]\n\n* Item\n\n||Name||Status||\n|API|Done|",
      "https://example.atlassian.net",
    );
    expect(markdown).toContain("## Release");
    expect(markdown).toContain("**Owner:** @chandler");
    expect(markdown).toContain("* Item");
    expect(markdown).toContain("|Name|Status|");
  });

  test("converts Markdown back to Jira Wiki and preserves exact raw strings", () => {
    expect(markdownToJiraWiki("## Plan\n\n**Important**")).toContain(
      "h2. Plan",
    );
    expect(rawJiraText(" exact\ntext ")).toBe(" exact\ntext ");
    expect(rawJiraText({ type: "doc", version: 1 })).toContain('"type": "doc"');
  });

  test("removes ADF round-trip metadata from user-facing Markdown", () => {
    expect(
      stripAdfMarkdownMetadata(
        '<!-- adf:paragraph attrs=\'{"localId":"794242e5a900"}\' -->\n\nDeployment notes\n\n<!-- /adf:paragraph -->',
      ),
    ).toBe("Deployment notes");
  });
});
