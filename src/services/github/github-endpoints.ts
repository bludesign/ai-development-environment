import "server-only";

/**
 * GitHub API endpoints. Both are overridable by environment variable so the screenshot capture
 * run can point GitHub traffic at the local stub in scripts/mock-api-server.ts. They are unset
 * in normal operation, where these resolve to the real public API.
 */
export const GITHUB_API_BASE_URL = (
  process.env.GITHUB_API_BASE_URL || "https://api.github.com"
).replace(/\/+$/, "");

export const GITHUB_GRAPHQL_URL =
  process.env.GITHUB_GRAPHQL_URL || `${GITHUB_API_BASE_URL}/graphql`;
