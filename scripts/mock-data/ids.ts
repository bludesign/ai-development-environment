/**
 * Deterministic identifiers shared by the mock seed and the Playwright screenshot manifest.
 * Detail routes navigate to these exact IDs, so the seed must create matching records.
 * Names are intentionally generic ("Acme") for public-facing screenshots.
 */
export const ids = {
  apps: {
    customerPortal: "app-acme-customer-portal",
    mobileSuite: "app-acme-mobile-suite",
  },
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
    /** The GitLab-backed checkout; seeded by scripts/mock-data/gitlab.ts. */
    gitlabRetry: "worktree-gitlab-retry-diagnostics",
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
    /** Paused on a pending question — the Action Center's second "needs attention" item. */
    planCheckoutQuestion: "run-plan-checkout-question",
  },
  runQuestionBatches: {
    planCheckout: "question-batch-plan-checkout",
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
    review: "skill-code-reviewer",
    migrations: "skill-migration-planner",
    release: "skill-release-notes",
    triage: "skill-bug-triage",
    perf: "skill-perf-profiler",
    a11y: "skill-accessibility-audit",
    apiDocs: "skill-api-contract",
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
    /** Still running — the Action Center's second "active" item. */
    running: "workflow-run-running",
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
    profileAppStoreUuid: "acme0000-1111-2222-3333-444455556666",
    profileAppStoreContentHash: "sha256-appstore-profile-0001",
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
  gitlab: {
    projectId: "1001",
    mergeRequestIid: 42,
  },
  mcpPresets: {
    core: "mcp-preset-core",
  },
  externalMcpServers: {
    linear: "mcp-server-linear",
  },
  push: {
    batch: "push-batch-release",
    certificate: "apns-cert-acme",
    registration: "apns-registration-1",
    preset: "push-preset-release",
  },
  notifications: {
    buildFailed: "notification-build-failed",
  },
  ccusageCollections: {
    /**
     * Doubles as the Usage page's collection request id — playwright/routes.ts pins the
     * page's client-generated id to this value so it resolves the seeded, already-finished
     * collection instead of dispatching a fresh one no agent can answer.
     */
    captured: "0f1e2d3c-4b5a-4697-8899-aabbccddeeff",
  },
  buildDataCollections: {
    /**
     * Doubles as the Build Data page's collection request id — playwright/routes.ts pins the
     * page's client-generated id to this value so it resolves the seeded, already-finished
     * scan instead of dispatching fresh scan jobs no agent can answer. Those jobs would stay
     * QUEUED for the rest of the capture and show up in the Polling page's pending job counts.
     */
    captured: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  },
  tailscaleTemplates: {
    dashboard: "tailscale-template-dashboard",
    postgres: "tailscale-template-postgres",
  },
  tailscaleOperations: {
    /**
     * Doubles as the Tailscale page's inspection request id. Playwright pins the
     * client-generated id to this finished operation so opening the page does not
     * enqueue fresh agent jobs in the shared screenshot database.
     */
    capturedInspection: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d",
  },
} as const;

/** Display numbers must be unique per their scope; kept here so the seed stays consistent. */
export const displayNumbers = {
  runs: {
    planSearch: 1001,
    sessionSearch: 2001,
    sessionAuth: 2002,
    planImported: 1002,
    planCheckoutQuestion: 1003,
  },
  commandRuns: {
    latest: 3001,
  },
  workflowRuns: {
    latest: 4001,
    running: 4002,
  },
} as const;
