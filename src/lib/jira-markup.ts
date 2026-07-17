import jira2md from "jira2md";

export type JiraTextFormat = "ADF" | "MARKDOWN" | "JIRA_WIKI";

const WIKI_PATTERNS = [
  /^h[1-6]\.\s/m,
  /^bq\.\s/m,
  /\{code(?::[^}]+)?\}/i,
  /\{noformat\}/i,
  /\{\{[^}\n]+\}\}/,
  /^\|\|.+\|\|\s*$/m,
  /\[[^\]\n]+\|https?:\/\//i,
  /\[~[^\]\n]+\]/,
  /\[\^[^\]\n]+\]/,
  /![^!\n]+!/,
];

export function isAdfDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "doc" &&
    record.version === 1 &&
    Array.isArray(record.content)
  );
}

export function detectJiraTextFormat(value: unknown): JiraTextFormat {
  if (isAdfDocument(value)) return "ADF";
  const text = typeof value === "string" ? value : "";
  return WIKI_PATTERNS.some((pattern) => pattern.test(text))
    ? "JIRA_WIKI"
    : "MARKDOWN";
}

function protectWikiReferences(value: string, siteUrl?: string): string {
  return value
    .replace(/\[~([^\]\n]+)\]/g, "@$1")
    .replace(/\[\^([^\]\n]+)\]/g, "[Attachment: $1]")
    .replace(/\[([A-Z][A-Z0-9_]*-\d+)\]/g, (_match, issueKey: string) =>
      siteUrl
        ? `[${issueKey}](${siteUrl}/browse/${issueKey})`
        : `**${issueKey}**`,
    );
}

export function jiraWikiToMarkdown(value: string, siteUrl?: string): string {
  return jira2md.to_markdown(protectWikiReferences(value, siteUrl));
}

export function markdownToJiraWiki(value: string): string {
  return jira2md.to_jira(value);
}

export function stripAdfMarkdownMetadata(value: string): string {
  return value
    .replace(/<!--\s*\/?adf:[\s\S]*?-->/gi, "")
    .replace(/^[\t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function rawJiraText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}
