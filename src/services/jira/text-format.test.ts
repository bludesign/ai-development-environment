import { describe, expect, test } from "vitest";

import { jiraTextInputToAdf, normalizeJiraRichText } from "./text-format";

describe("Jira rich-text normalization", () => {
  test("normalizes ADF into editable Markdown and Wiki source", () => {
    const raw = {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Important", marks: [{ type: "strong" }] },
          ],
        },
      ],
    };
    const content = normalizeJiraRichText(raw);
    expect(content).toMatchObject({ format: "ADF", raw });
    expect(content?.markdown).toContain("**Important**");
    expect(content?.wikiMarkup).toContain("*Important*");
  });

  test("converts Markdown and Jira Wiki authoring into Jira Cloud ADF", () => {
    const markdown = jiraTextInputToAdf({
      format: "MARKDOWN",
      value: "## Plan\n\n- **Test**",
    });
    const wiki = jiraTextInputToAdf({
      format: "JIRA_WIKI",
      value: "h2. Plan\n\n* *Test*",
    });
    expect(markdown).toMatchObject({ type: "doc", version: 1 });
    expect(wiki).toMatchObject({ type: "doc", version: 1 });
    expect(JSON.stringify(markdown)).toContain("heading");
    expect(JSON.stringify(wiki)).toContain("bulletList");
  });
});
