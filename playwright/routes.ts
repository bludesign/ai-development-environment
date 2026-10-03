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
  /** Read the fixed Jira seed instead of the cache shared by parallel page loads. */
  stubJiraCacheTicket?: boolean;
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
  buildWorkflow?: "start" | "custom" | "script" | "project";
  /** Open a transfer review without applying configuration or queuing clones. */
  transferWorkflow?: "export" | "import" | "import-destinations";
  /** Auth pages are intentionally captured without the seeded bearer session. */
  anonymous?: boolean;
  /** Capture the global focus menu after its catalog has loaded. */
  activeAgentMenu?: boolean;
  mcpImportReview?: boolean;
  mcpAiPrompt?: boolean;
};

export const routes: RouteEntry[] = [
  { name: "sign-in", path: "/sign-in", anonymous: true },
  { name: "register", path: "/register", anonymous: true },
  // Overview / action center
  { name: "dashboard", path: "/dashboard/action-center" },

  // Apps
  {
    name: "apps",
    path: "/dashboard/apps",
    readyGraphqlOperation: "AppsPage",
    readyTexts: ["Customer Portal"],
  },
  {
    name: "app-detail",
    path: `/dashboard/apps/${ids.apps.customerPortal}`,
    readyGraphqlOperation: "AppDetail",
    readyTexts: ["Customer Portal"],
  },
  {
    name: "app-sync",
    path: `/dashboard/apps/${ids.apps.customerPortal}?view=sync`,
    readyGraphqlOperation: "AppRepositorySync",
    readyTexts: ["Sync repositories"],
  },
  {
    name: "app-export",
    path: `/dashboard/apps/${ids.apps.customerPortal}`,
    readyGraphqlOperation: "AppDetail",
    readyTexts: ["Customer Portal"],
    transferWorkflow: "export",
  },
  {
    name: "app-import-review",
    path: `/dashboard/apps/${ids.apps.customerPortal}`,
    readyGraphqlOperation: "AppDetail",
    readyTexts: ["Customer Portal"],
    transferWorkflow: "import",
  },
  {
    name: "app-import-destinations",
    path: `/dashboard/apps/${ids.apps.customerPortal}`,
    readyGraphqlOperation: "AppDetail",
    readyTexts: ["Customer Portal"],
    transferWorkflow: "import-destinations",
  },

  // Agents
  { name: "agents", path: "/dashboard/agents" },
  { name: "agent-detail", path: `/dashboard/agents/${ids.agents.studio}` },

  // Runs
  { name: "sessions", path: "/ai/sessions" },
  { name: "session-detail", path: `/ai/sessions/${ids.runs.sessionSearch}` },
  { name: "plans", path: "/ai/plans" },
  { name: "plan-detail", path: `/ai/plans/${ids.runs.planSearch}` },
  { name: "drafts", path: "/ai/drafts" },
  { name: "run-new", path: "/ai/drafts/new" },

  // Codebases & worktrees
  { name: "codebases", path: "/dashboard/codebases" },
  {
    name: "codebase-branches",
    path: "/dashboard/codebases",
    clickTab: "Branches",
  },
  {
    name: "codebase-detail",
    path: `/dashboard/codebases/${ids.codebases.web}`,
  },
  {
    name: "repository-detail",
    path: `/dashboard/codebases/repositories/${ids.repositories.web}`,
  },
  {
    name: "repository-external-actions",
    path: "/dashboard/codebases/repositories/repo-acme-gitlab-platform",
    clickTab: "External pipeline actions",
  },
  {
    name: "repository-export",
    path: `/dashboard/codebases/repositories/${ids.repositories.ios}`,
    transferWorkflow: "export",
  },
  {
    name: "repository-preparations",
    path: `/dashboard/codebases/repositories/${ids.repositories.web}`,
    clickTab: "Preparations",
  },
  { name: "worktrees", path: "/dashboard/worktrees" },
  {
    name: "active-agent-selector",
    path: "/dashboard/worktrees",
    activeAgentMenu: true,
  },
  {
    name: "active-agent-worktrees",
    path: "/dashboard/worktrees",
    initScript: `localStorage.setItem("ade.active-agent.user-screenshot-admin", JSON.stringify({activeAgentId: "${ids.agents.studio}", pageAgents: {}}));`,
    readyTexts: ["Controlled by Active Agent"],
  },
  {
    name: "prepare",
    path: "/system/prepare",
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
    path: `/dashboard/worktrees/${ids.worktrees.webFeature}`,
    stubWorktree: true,
  },
  {
    // Pinned to the worktree the seeded coverage report measured, with that report selected,
    // so the capture shows the coverage overlay rather than an unannotated diff.
    name: "changes",
    path: `/dashboard/changes?worktree=${ids.worktrees.iosMain}&scope=BRANCH&coverage=report-archive-coverage&path=AcmeApp/Search/SearchCoordinator.swift`,
    stubWorktree: true,
  },

  // Builds
  { name: "builds", path: "/dashboard/builds" },
  {
    name: "build-configurations",
    path: "/dashboard/builds",
    clickTab: "Configurations",
  },
  {
    name: "build-configuration-detail",
    path: `/dashboard/builds/configurations/${ids.buildConfigurations.release}`,
  },
  { name: "build-custom-detail", path: "/dashboard/builds/build-ios-custom" },
  {
    name: "build-script-editor",
    path: "/dashboard/builds",
    buildWorkflow: "script",
  },
  {
    name: "build-start",
    path: `/dashboard/apps/${ids.apps.mobileSuite}`,
    stubWorktree: true,
    buildWorkflow: "start",
  },
  {
    name: "build-custom",
    path: `/dashboard/apps/${ids.apps.mobileSuite}`,
    stubWorktree: true,
    buildWorkflow: "custom",
  },
  {
    name: "repository-ios-project",
    path: `/dashboard/codebases/repositories/${ids.repositories.ios}`,
    stubWorktree: true,
    buildWorkflow: "project",
  },
  {
    name: "app-build-overview",
    scrollTo: "[data-build-repository]",
    path: `/dashboard/apps/${ids.apps.mobileSuite}`,
    readyTexts: ["Latest repository build"],
  },
  { name: "build-detail", path: `/dashboard/builds/${ids.builds.archive}` },
  {
    name: "build-coverage",
    path: `/dashboard/builds/${ids.builds.archive}/coverage`,
  },
  {
    name: "build-data",
    path: "/system/build-data",
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
    path: "/system/tailscale",
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
  { name: "commands", path: "/dashboard/commands" },
  { name: "command-new", path: "/dashboard/commands/new" },
  {
    name: "command-edit",
    path: `/dashboard/commands/${ids.commands.runTests}/edit`,
  },
  {
    name: "command-run",
    path: `/dashboard/commands/runs/${ids.commandRuns.latest}`,
  },

  // Devices
  { name: "devices", path: "/system/devices" },
  { name: "device-detail", path: `/system/devices/${ids.devices.iphone}` },
  { name: "device-enroll", path: "/system/devices/enroll" },

  // Jobs
  { name: "job-detail", path: `/dashboard/jobs/${ids.jobs.codebaseRefresh}` },

  // GitHub
  {
    name: "pull-requests",
    path: "/github/pull-requests",
    readyGraphqlOperation: "GitHubPullRequests",
    readyTexts: [
      "Add quick search to the global navigation bar",
      "No pull requests",
    ],
  },
  {
    name: "pull-request-detail",
    path: `/github/pull-requests/${ids.pullRequests.owner}/${ids.pullRequests.repository}/${ids.pullRequests.number}`,
  },
  { name: "actions", path: "/github/actions" },
  { name: "actions-cache", path: "/github/actions-cache" },
  {
    name: "comments",
    path: "/github/comments",
    readyGraphqlOperation: "GitHubReviewThreads",
    readyTexts: [
      "This debounce is recreated on every render — move it into a ref so typing does not reset the timer.",
      "No review comments",
    ],
  },
  { name: "webhooks", path: "/github/webhooks" },
  { name: "polling", path: "/system/polling" },
  { name: "github-cache", path: "/github/cache" },
  {
    name: "github-cache-entry",
    path: `/github/cache/entries/${ids.githubCacheEntries.pullRequests}`,
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
    readyTexts: ["#118 · feature/retry-diagnostics", "No pipelines"],
  },
  {
    name: "gitlab-comments",
    path: "/gitlab/comments",
    readyGraphqlOperation: "GitLabComments",
    readyTexts: [
      "Ready for another look — the pipeline failure is the flaky integration job, not this change.",
      "No comments",
    ],
  },
  {
    // The same worktree detail page as `worktree-detail`, but on the GitLab-backed checkout, so
    // it photographs the merge-request and pipeline cards instead of their GitHub equivalents.
    // Stubbed for the same reason: the page inspects the checkout on load.
    name: "gitlab-worktree-detail",
    path: `/dashboard/worktrees/${ids.worktrees.gitlabRetry}`,
    stubWorktree: true,
  },
  {
    // Settings → Integrations → GitLab, the credential-only card the setup page describes.
    // It sits below the fold behind the Jira and GitHub cards, hence the scroll.
    name: "gitlab-settings",
    path: "/system/settings",
    scrollTo: "#gitlab-token",
  },
  { name: "gitlab-webhooks", path: "/gitlab/webhooks" },
  { name: "gitlab-cache", path: "/gitlab/cache" },

  // Jira
  { name: "jira-tickets", path: "/jira/tickets" },
  { name: "jira-ticket-detail", path: `/jira/tickets/${ids.jira.issueKey}` },
  { name: "jira-webhooks", path: "/jira/webhooks" },
  { name: "jira-cache", path: "/jira/cache" },
  {
    name: "jira-cache-ticket",
    stubJiraCacheTicket: true,
    readyGraphqlOperation: "CachedJiraTicket",
    readyTexts: ["Summary response"],
    path: `/jira/cache/tickets/${ids.jira.issueKey}`,
  },

  // Skills
  { name: "skills", path: "/ai/skills" },
  { name: "skill-detail", path: `/ai/skills/${ids.skills.lint}` },
  { name: "skill-groups", path: "/ai/skills/groups" },
  {
    name: "skill-group-detail",
    path: `/ai/skills/groups/${ids.skillGroups.core}`,
  },
  {
    name: "skill-sync-run",
    path: `/ai/skills/sync/${ids.skillSyncRuns.latest}`,
  },

  // Tools
  { name: "tools", path: "/system/tools", readyTexts: ["Core Tools"] },
  {
    name: "tools-catalog-export",
    path: "/system/tools",
    readyTexts: ["Core Tools"],
    clickButton: "Export tool catalog",
  },
  {
    name: "tools-preset-editor",
    path: "/system/tools",
    readyTexts: ["Core Tools"],
    clickButton: "Edit preset",
  },
  {
    name: "tools-preset-import",
    path: "/system/tools",
    readyTexts: ["Core Tools"],
    mcpImportReview: true,
  },
  {
    name: "tools-preset-ai-prompt",
    path: "/system/tools",
    readyTexts: ["Core Tools"],
    clickButton: "Import presets",
    mcpAiPrompt: true,
  },

  // Workflows
  { name: "workflows", path: "/dashboard/workflows" },
  {
    name: "workflow-detail",
    path: `/dashboard/workflows/${ids.workflows.prReview}`,
  },
  {
    name: "workflow-edit",
    path: `/dashboard/workflows/${ids.workflows.prReview}/edit`,
  },
  { name: "workflow-new", path: "/dashboard/workflows/new" },
  {
    name: "workflow-run",
    path: `/dashboard/workflows/runs/${ids.workflowRuns.latest}`,
  },

  // Signing
  { name: "provisioning-profiles", path: "/system/provisioning-profiles" },
  {
    // Signing profiles are addressed by their composite `uuid:contentHash`, not the row id.
    name: "provisioning-profile-detail",
    path: `/system/provisioning-profiles/${ids.signing.profileAppStoreUuid}:${ids.signing.profileAppStoreContentHash}`,
  },

  // Observability
  { name: "console-logs", path: "/debugging/console-logs" },
  { name: "analytics-events", path: "/debugging/analytics-events" },
  { name: "unified-events", path: "/debugging/unified-events" },

  // Crash reports and dSYMs
  {
    name: "crashes",
    path: "/debugging/crashes",
    readyGraphqlOperation: "CrashesPage",
    readyTexts: ["EXC_BREAKPOINT · CartViewModel.item(at:)"],
  },
  {
    name: "crash-detail",
    path: `/debugging/crashes/${ids.crashes.checkout}`,
    readyGraphqlOperation: "CrashDetail",
    readyTexts: ["CheckoutView.submit()"],
  },
  {
    name: "crashes-dsyms",
    path: "/debugging/crashes/dsyms",
    readyGraphqlOperation: "DsymsPage",
    readyTexts: ["AcmeWidgets.appex.dSYM"],
  },
  {
    name: "dsym-detail",
    path: `/debugging/crashes/dsyms/${ids.dsyms.app}`,
    readyGraphqlOperation: "DsymDetail",
    readyTexts: ["3F9C7E2A-1B4D-4C8E-9A0B-1C2D3E4F5A6B"],
  },

  // Hosted SSE endpoints
  {
    name: "sse-endpoints",
    path: "/debugging/sse",
    readyGraphqlOperation: "SseEndpointsPage",
    readyTexts: ["Product recommendation stream"],
  },
  {
    name: "sse-endpoint-detail",
    path: `/debugging/sse/${ids.sse.productFeed}`,
    readyGraphqlOperation: "SseEndpointDetail",
    readyTexts: ["Product recommendation stream"],
  },
  {
    name: "sse-mocks",
    path: `/debugging/sse/${ids.sse.productFeed}/mocks`,
    readyGraphqlOperation: "SseEndpointDetail",
    readyTexts: ["Mock composition builder"],
  },
  {
    name: "sse-breakpoints",
    path: "/debugging/sse/breakpoints",
    readyGraphqlOperation: "SseBreakpointsPage",
    readyTexts: ["Assistant response stream"],
  },
  {
    name: "sse-storage",
    path: "/debugging/sse/storage",
    readyGraphqlOperation: "SseStoragePage",
    readyTexts: ["tenant-config"],
  },
  {
    name: "sse-history",
    path: "/debugging/sse/history",
    readyGraphqlOperation: "SseHistoryPage",
    readyTexts: ["Product recommendation stream"],
  },
  {
    name: "sse-stream-history",
    path: `/debugging/sse/history/${ids.sse.history}`,
    readyGraphqlOperation: "SseHistoryDetail",
    readyTexts: ["Product recommendation Stream", "display_card"],
  },

  // Usage & costs
  {
    name: "usage",
    path: "/ai/usage",
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
  { name: "costs", path: "/ai/costs" },

  // Notifications & push
  { name: "notifications", path: "/dashboard/notifications" },
  { name: "push-notifications", path: "/debugging/push-notifications" },

  // System
  {
    name: "status",
    path: "/system/status",
    readyGraphqlOperation: "InstallationStatus",
    readyTexts: ["Studio Mac"],
  },
  {
    name: "cli-health-checks",
    path: "/system/status",
    readyGraphqlOperation: "InstallationStatus",
    readyTexts: ["Studio Mac"],
    clickButton: "CLI health check settings",
  },
  { name: "users", path: "/system/users", readyTexts: ["Avery Morgan"] },
  { name: "api-keys", path: "/system/api-keys", readyTexts: ["CI automation"] },
  { name: "credentials", path: "/system/credentials" },
  { name: "settings", path: "/system/settings" },
];
