const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

function normalizedIssueKey(value: string | null): string | null {
  const key = value?.trim().toUpperCase() ?? "";
  return ISSUE_KEY_PATTERN.test(key) ? key : null;
}

export function parseJiraIssueKey(value: string): string | null {
  const directKey = normalizedIssueKey(value);
  if (directKey) return directKey;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const selectedIssue = normalizedIssueKey(
    url.searchParams.get("selectedIssue"),
  );
  if (selectedIssue) return selectedIssue;

  const segments = url.pathname.split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!/^(browse|issues)$/i.test(segments[index]!)) continue;
    const issueKey = normalizedIssueKey(segments[index + 1]!);
    if (issueKey) return issueKey;
  }
  return null;
}
