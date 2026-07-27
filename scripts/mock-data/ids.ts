/**
 * Deterministic identifiers shared by the mock seed and the Playwright screenshot manifest.
 * Detail routes navigate to these exact IDs, so the seed must create matching records.
 * Names are intentionally generic ("Acme") for public-facing screenshots.
 */
export const ids = {
  agents: {
    studio: "agent-studio-mac",
    build: "agent-build-mac",
    ci: "agent-ci-runner",
  },
  repositories: {
    web: "repo-acme-web-app",
    ios: "repo-acme-ios-app",
    api: "repo-acme-api",
  },
  codebases: {
    web: "codebase-acme-web-app",
    ios: "codebase-acme-ios-app",
    api: "codebase-acme-api",
  },
  worktrees: {
    webMain: "worktree-web-main",
    webFeature: "worktree-web-feature-search",
    iosMain: "worktree-ios-main",
    apiFeature: "worktree-api-feature-auth",
  },
  worktreeTags: {
    review: "tag-in-review",
    ready: "tag-ready",
    blocked: "tag-blocked",
  },
  runs: {
    planSearch: "run-plan-quick-search",
    sessionSearch: "run-session-quick-search",
    sessionAuth: "run-session-api-auth",
    planImported: "run-plan-imported",
  },
  runDrafts: {
    refactor: "draft-refactor-checkout",
  },
  jobs: {
    codebaseRefresh: "job-codebase-refresh-1",
  },
  builds: {
    archive: "build-ios-archive-1",
    test: "build-ios-test-1",
  },
  buildProjects: {
    ios: "project-acme-ios-app",
  },
  buildSources: {
    ios: "source-acme-ios-app",
  },
  buildConfigurations: {
    release: "config-ios-release",
  },
  buildScripts: {
    swiftlint: "script-swiftlint",
  },
  devices: {
    iphone: "device-iphone-15-pro",
    ipad: "device-ipad-air",
  },
  deviceEnrollments: {
    pending: "device-enrollment-pending",
  },
  skills: {
    lint: "skill-lint-guardrails",
    docs: "skill-doc-writer",
    tests: "skill-test-author",
  },
  skillGroups: {
    core: "skill-group-core",
  },
  skillSyncRuns: {
    latest: "skill-sync-run-latest",
  },
  workflows: {
    prReview: "workflow-pr-review",
  },
  workflowVersions: {
    prReviewV1: "workflow-version-pr-review-1",
  },
  workflowRuns: {
    latest: "workflow-run-latest",
  },
  commands: {
    runTests: "command-run-tests",
    deployStaging: "command-deploy-staging",
  },
  commandRuns: {
    latest: "command-run-latest",
  },
  signing: {
    profileAppStore: "signing-profile-app-store",
    certificateDistribution: "signing-cert-distribution",
  },
  githubCacheEntries: {
    pullRequests: "github-cache-pull-requests",
  },
  jira: {
    projectId: "jira-project-acme",
    projectKey: "ACME",
    sourceId: "jira-source-active-sprint",
    issueKey: "ACME-1234",
  },
  pullRequests: {
    owner: "acme",
    repository: "web-app",
    number: 42,
  },
  mcpPresets: {
    core: "mcp-preset-core",
  },
  externalMcpServers: {
    linear: "mcp-server-linear",
  },
  push: {
    batch: "push-batch-release",
    registration: "apns-registration-1",
    preset: "push-preset-release",
  },
  notifications: {
    buildFailed: "notification-build-failed",
  },
} as const;

/** Display numbers must be unique per their scope; kept here so the seed stays consistent. */
export const displayNumbers = {
  runs: {
    planSearch: 1001,
    sessionSearch: 2001,
    sessionAuth: 2002,
    planImported: 1002,
  },
  commandRuns: {
    latest: 3001,
  },
  workflowRuns: {
    latest: 4001,
  },
} as const;
