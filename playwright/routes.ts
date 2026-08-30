import { ids } from "../scripts/mock-data/ids";

/**
 * Every page route in the app, paired with a stable screenshot name. Detail routes reference
 * the deterministic IDs the mock seed creates, so they always resolve to a populated record.
 * Paths are locale-relative; the capture spec prefixes `/en`.
 */
export type RouteEntry = {
  name: string;
  path: string;
  /** Full-page capture by default; set false for pages better shown at viewport height. */
  fullPage?: boolean;
  /** Client GraphQL operation that must finish before the screenshot is written. */
  readyGraphqlOperation?: string;
  /** One of these terminal-state texts must render after the ready operation finishes. */
  readyTexts?: string[];
  /**
   * JavaScript evaluated before any of the page's own scripts run. Only for pages whose data
   * depends on an id the client mints at random; see the `usage` route.
   */
  initScript?: string;
  /**
   * Answer the worktree inspection mutations from a fixture instead of the (absent) agent.
   * For pages that inspect a checkout live; see playwright/worktree-stub.ts.
   */
  stubWorktree?: boolean;
  /**
   * CSS selector centered in the viewport before the capture. The dashboard shell scrolls
   * inside itself, so `fullPage` never grows past the viewport height and a card below the
   * fold can only be photographed by scrolling to it first.
   */
  scrollTo?: string;
  /** Accessible button name clicked after the page reaches its ready state. */
  clickButton?: string;
  /** Accessible tab name selected after the page reaches its ready state. */
  clickTab?: string;
  /** Auth pages are intentionally captured without the seeded bearer session. */
  anonymous?: boolean;
};

export const routes: RouteEntry[] = [
  { name: "sign-in", path: "/sign-in", anonymous: true },
  { name: "register", path: "/register", anonymous: true },
  // Overview / action center
  { name: "dashboard", path: "/" },

  // Apps
  {
    name: "apps",
    path: "/apps",
    readyGraphqlOperation: "AppsPage",
    readyTexts: ["Customer Portal"],
  },
  {
    name: "app-detail",
    path: `/apps/${ids.apps.customerPortal}`,
    readyGraphqlOperation: "AppDetail",
    readyTexts: ["Customer Portal"],
  },

  // Agents
  { name: "agents", path: "/agents" },
  { name: "agent-detail", path: `/agents/${ids.agents.studio}` },

  // Runs
  { name: "sessions", path: "/sessions" },
  { name: "session-detail", path: `/sessions/${ids.runs.sessionSearch}` },
  { name: "plans", path: "/plans" },
  { name: "plan-detail", path: `/plans/${ids.runs.planSearch}` },
  { name: "drafts", path: "/drafts" },
  { name: "run-new", path: "/runs/new" },

  // Codebases & worktrees
  { name: "codebases", path: "/codebases" },
  { name: "codebase-detail", path: `/codebases/${ids.codebases.web}` },
  {
    name: "repository-detail",
    path: `/codebases/repositories/${ids.repositories.web}`,
  },
  {
    name: "repository-preparations",
    path: `/codebases/repositories/${ids.repositories.web}`,
    clickTab: "Preparations",
  },
  { name: "worktrees", path: "/worktrees" },
  {
    name: "prepare",
    path: "/prepare",
    readyGraphqlOperation: "WorktreePreparationOverview",
    readyTexts: ["web-app"],
  },
  {
    // The page inspects the checkout on load, which queues a job for the Mac that owns it and
    // leaves it QUEUED for the rest of the capture: the page then photographs its "operation in
    // progress" fallback, and the Polling page counts the job as pending reconciliation work.
    // The stub answers the inspection instead, so the commits and changes render and no job is
    // dispatched.
    name: "worktree-detail",
    path: `/worktrees/${ids.worktrees.webFeature}`,
    stubWorktree: true,
  },
  {
    // Pinned to the worktree the seeded coverage report measured, with that report selected,
    // so the capture shows the coverage overlay rather than an unannotated diff.
    name: "changes",
    path: `/changes?worktree=${ids.worktrees.iosMain}&scope=BRANCH&coverage=report-archive-coverage&path=AcmeApp/Search/SearchCoordinator.swift`,
    stubWorktree: true,
  },

  // Builds
  { name: "builds", path: "/builds" },
  { name: "build-detail", path: `/builds/${ids.builds.archive}` },
  { name: "build-coverage", path: `/builds/${ids.builds.archive}/coverage` },
  {
    name: "build-data",
    path: "/build-data",
    // The page starts a Derived Data scan under a request id from `createClientId()` and waits
    // for every online agent to answer. No agent is connected during a capture, so a random id
    // photographs the queued progress card and leaves three QUEUED jobs behind — jobs the
    // Polling page counts as pending reconciliation work, making that count depend on how many
    // captures ran first. Pinning the id to the finished collection the seed wrote
    // (scripts/mock-data/build-data.ts) returns a completed scan and dispatches nothing.
    initScript: `Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => "${ids.buildDataCollections.captured}",
    });`,
  },
  {
    name: "tailscale",
    path: "/tailscale",
    readyGraphqlOperation: "TailscaleServeOverview",
    readyTexts: ["Developer dashboard", "studio.acme-tailnet.ts.net"],
    // The page automatically inspects every agent. Reuse the finished inspection seeded in
    // scripts/mock-data/tailscale.ts so each viewport does not add live QUEUED jobs that make
    // the Polling screenshot's pendingJobs detail depend on capture timing.
    initScript: `Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => "${ids.tailscaleOperations.capturedInspection}",
    });`,
  },

  // Commands
  { name: "commands", path: "/commands" },
  { name: "command-new", path: "/commands/new" },
  { name: "command-edit", path: `/commands/${ids.commands.runTests}/edit` },
  { name: "command-run", path: `/commands/runs/${ids.commandRuns.latest}` },

  // Devices
  { name: "devices", path: "/devices" },
  { name: "device-detail", path: `/devices/${ids.devices.iphone}` },
  { name: "device-enroll", path: "/devices/enroll" },

  // Jobs
  { name: "job-detail", path: `/jobs/${ids.jobs.codebaseRefresh}` },

  // GitHub
  {
    name: "pull-requests",
    path: "/pull-requests",
    readyGraphqlOperation: "GitHubPullRequests",
    readyTexts: [
      "Add quick search to the global navigation bar",
      "No pull requests",
    ],
  },
  {
    name: "pull-request-detail",
    path: `/pull-requests/${ids.pullRequests.owner}/${ids.pullRequests.repository}/${ids.pullRequests.number}`,
  },
  { name: "actions", path: "/actions" },
  { name: "actions-cache", path: "/actions-cache" },
  {
    name: "comments",
    path: "/comments",
    readyGraphqlOperation: "GitHubReviewThreads",
    readyTexts: [
      "This debounce is recreated on every render — move it into a ref so typing does not reset the timer.",
      "No review comments",
    ],
  },
  { name: "webhooks", path: "/webhooks" },
  { name: "polling", path: "/polling" },
  { name: "github-cache", path: "/github-cache" },
  {
    name: "github-cache-entry",
    path: `/github-cache/entries/${ids.githubCacheEntries.pullRequests}`,
  },

  // GitLab
  {
    name: "gitlab-merge-requests",
    path: "/gitlab/merge-requests",
    readyGraphqlOperation: "GitLabMergeRequests",
    readyTexts: ["Improve pipeline retry diagnostics", "No merge requests"],
  },
  {
    // The detail page fans out to four cached GitLab REST reads; `GitLabMergeRequest` is the
    // GraphQL operation that wraps all of them. Its name is a prefix of `GitLabMergeRequests`,
    // but that list query never runs here, so the match stays unambiguous.
    name: "gitlab-merge-request-detail",
    path: `/gitlab/merge-requests/${ids.gitlab.projectId}/${ids.gitlab.mergeRequestIid}`,
    readyGraphqlOperation: "GitLabMergeRequest",
    readyTexts: ["Improve pipeline retry diagnostics"],
  },
  {
    name: "gitlab-pipelines",
    path: "/gitlab/pipelines",
    readyGraphqlOperation: "GitLabPipelines",
    readyTexts: ["#9401 · feature/retry-diagnostics", "No pipelines"],
  },
  {
    name: "gitlab-comments",
    path: "/gitlab/comments",
    readyGraphqlOperation: "GitLabCommentMergeRequests",
    readyTexts: [
      "Improve pipeline retry diagnostics",
      "No open merge requests",
    ],
  },
  {
    // The same worktree detail page as `worktree-detail`, but on the GitLab-backed checkout, so
    // it photographs the merge-request and pipeline cards instead of their GitHub equivalents.
    // Stubbed for the same reason: the page inspects the checkout on load.
    name: "gitlab-worktree-detail",
    path: `/worktrees/${ids.worktrees.gitlabRetry}`,
    stubWorktree: true,
  },
  {
    // Settings → Integrations → GitLab, the card the setup and managed-project pages describe.
    // It sits below the fold behind the Jira and GitHub cards, hence the scroll.
    name: "gitlab-settings",
    path: "/settings",
    scrollTo: "#gitlab-token",
  },
  { name: "gitlab-webhooks", path: "/gitlab/webhooks" },
  { name: "gitlab-cache", path: "/gitlab/cache" },

  // Jira
  { name: "jira-tickets", path: "/jira/tickets" },
  { name: "jira-ticket-detail", path: `/jira/tickets/${ids.jira.issueKey}` },
  { name: "jira-webhooks", path: "/jira-webhooks" },
  { name: "jira-cache", path: "/jira-cache" },
  {
    name: "jira-cache-ticket",
    path: `/jira-cache/tickets/${ids.jira.issueKey}`,
  },

  // Skills
  { name: "skills", path: "/skills" },
  { name: "skill-detail", path: `/skills/${ids.skills.lint}` },
  { name: "skill-groups", path: "/skills/groups" },
  {
    name: "skill-group-detail",
    path: `/skills/groups/${ids.skillGroups.core}`,
  },
  { name: "skill-sync-run", path: `/skills/sync/${ids.skillSyncRuns.latest}` },

  // Tools
  { name: "tools", path: "/tools" },

  // Workflows
  { name: "workflows", path: "/workflows" },
  { name: "workflow-detail", path: `/workflows/${ids.workflows.prReview}` },
  { name: "workflow-edit", path: `/workflows/${ids.workflows.prReview}/edit` },
  { name: "workflow-new", path: "/workflows/new" },
  { name: "workflow-run", path: `/workflows/runs/${ids.workflowRuns.latest}` },

  // Signing
  { name: "provisioning-profiles", path: "/provisioning-profiles" },
  {
    // Signing profiles are addressed by their composite `uuid:contentHash`, not the row id.
    name: "provisioning-profile-detail",
    path: `/provisioning-profiles/${ids.signing.profileAppStoreUuid}:${ids.signing.profileAppStoreContentHash}`,
  },

  // Observability
  { name: "console-logs", path: "/console-logs" },
  { name: "analytics-events", path: "/analytics-events" },
  { name: "unified-events", path: "/unified-events" },

  // Hosted SSE endpoints
  {
    name: "sse-endpoints",
    path: "/sse",
    readyGraphqlOperation: "SseEndpointsPage",
    readyTexts: ["Product recommendation stream"],
  },
  {
    name: "sse-endpoint-detail",
    path: `/sse/${ids.sse.productFeed}`,
    readyGraphqlOperation: "SseEndpointDetail",
    readyTexts: ["Product recommendation stream"],
  },
  {
    name: "sse-mocks",
    path: `/sse/${ids.sse.productFeed}/mocks`,
    readyGraphqlOperation: "SseEndpointDetail",
    readyTexts: ["Mock composition builder"],
  },
  {
    name: "sse-breakpoints",
    path: "/sse/breakpoints",
    readyGraphqlOperation: "SseBreakpointsPage",
    readyTexts: ["Assistant response stream"],
  },
  {
    name: "sse-storage",
    path: "/sse/storage",
    readyGraphqlOperation: "SseStoragePage",
    readyTexts: ["tenant-config"],
  },
  {
    name: "sse-history",
    path: "/sse/history",
    readyGraphqlOperation: "SseHistoryPage",
    readyTexts: ["Product recommendation stream"],
  },

  // Usage & costs
  {
    name: "usage",
    path: "/usage",
    // The page collects ccusage afresh under a request id from `createClientId()` and waits
    // for every online agent to report. No agent is connected during a capture, so a random
    // id leaves it on its spinner until the 150s collection deadline. Pinning the id to the
    // finished collection the seed wrote (scripts/mock-data/costs.ts) makes the first
    // reconcile return completed data instead.
    initScript: `Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => "${ids.ccusageCollections.captured}",
    });`,
  },
  { name: "costs", path: "/costs" },

  // Notifications & push
  { name: "notifications", path: "/notifications" },
  { name: "push-notifications", path: "/push-notifications" },

  // System
  {
    name: "status",
    path: "/status",
    readyGraphqlOperation: "InstallationStatus",
    readyTexts: ["Studio Mac"],
  },
  {
    name: "cli-health-checks",
    path: "/status",
    readyGraphqlOperation: "InstallationStatus",
    readyTexts: ["Studio Mac"],
    clickButton: "CLI health check settings",
  },
  { name: "users", path: "/users", readyTexts: ["Avery Morgan"] },
  { name: "api-keys", path: "/api-keys", readyTexts: ["CI automation"] },
  { name: "credentials", path: "/credentials" },
  { name: "settings", path: "/settings" },
];
