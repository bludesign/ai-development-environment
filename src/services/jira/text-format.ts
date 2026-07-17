import "server-only";

import { Parser, type ADFDocument } from "extended-markdown-adf-parser";

import {
  detectJiraTextFormat,
  isAdfDocument,
  jiraWikiToMarkdown,
  markdownToJiraWiki,
  rawJiraText,
} from "@/lib/jira-markup";

import type { JiraRichText, JiraTextInput } from "./types";

const parser = new Parser();

function fallbackAdfText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const ownText = typeof record.text === "string" ? record.text : "";
  const children = Array.isArray(record.content)
    ? record.content.map(fallbackAdfText).filter(Boolean)
    : [];
  return [ownText, ...children].filter(Boolean).join("\n");
}

function adfToMarkdown(value: unknown): string {
  try {
    return parser.adfToMarkdown(value as ADFDocument);
  } catch {
    return fallbackAdfText(value);
  }
}

export function normalizeJiraRichText(
  value: unknown,
  siteUrl?: string,
): JiraRichText | null {
  if (value === null || value === undefined) return null;
  const format = detectJiraTextFormat(value);
  const rawText = rawJiraText(value);
  const markdown =
    format === "ADF"
      ? adfToMarkdown(value)
      : format === "JIRA_WIKI"
        ? jiraWikiToMarkdown(rawText, siteUrl)
        : rawText;
  return {
    format,
    raw: value,
    rawText,
    markdown,
    wikiMarkup: format === "JIRA_WIKI" ? rawText : markdownToJiraWiki(markdown),
  };
}

export function jiraTextInputToAdf(input: JiraTextInput): ADFDocument {
  const value = input.value.trim();
  const markdown =
    input.format === "JIRA_WIKI" ? jiraWikiToMarkdown(value) : value;
  const document = parser.markdownToAdf(markdown);
  if (!isAdfDocument(document)) {
    throw new Error("The Jira text could not be converted to valid ADF");
  }
  return document;
}
