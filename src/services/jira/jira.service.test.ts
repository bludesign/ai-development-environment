import { describe, expect, test } from "vitest";

import {
  normalizeJiraSiteUrl,
  parseJiraBoardUrl,
  stableStringify,
} from "./jira.service";

describe("Jira service input helpers", () => {
  test("normalizes one Jira Cloud origin", () => {
    expect(normalizeJiraSiteUrl(" https://example.atlassian.net/path ")).toBe(
      "https://example.atlassian.net",
    );
  });

  test("rejects insecure and non-Cloud Jira hosts", () => {
    expect(() => normalizeJiraSiteUrl("http://example.atlassian.net")).toThrow(
      "HTTPS",
    );
    expect(() => normalizeJiraSiteUrl("https://jira.example.com")).toThrow(
      "Jira Cloud",
    );
  });

  test("extracts modern and legacy board IDs and enforces the site origin", () => {
    expect(
      parseJiraBoardUrl(
        "https://example.atlassian.net/jira/software/c/projects/APP/boards/42",
        "https://example.atlassian.net",
      ).boardId,
    ).toBe(42);
    expect(
      parseJiraBoardUrl(
        "https://example.atlassian.net/secure/RapidBoard.jspa?rapidView=73",
        "https://example.atlassian.net",
      ).boardId,
    ).toBe(73);
    expect(() =>
      parseJiraBoardUrl(
        "https://other.atlassian.net/jira/software/c/projects/APP/boards/42",
        "https://example.atlassian.net",
      ),
    ).toThrow("configured Jira site");
  });

  test("canonicalizes nested cache-key input", () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});
