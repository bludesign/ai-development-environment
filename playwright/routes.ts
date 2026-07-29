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
   * Only for pages whose whole body is a live diff; see playwright/worktree-stub.ts.
   */
  stubWorktree?: boolean;
};

export const routes: RouteEntry[] = [
  // Overview / action center
  { name: "dashboard", path: "/" },

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
  { name: "worktrees", path: "/worktrees" },
  { name: "worktree-detail", path: `/worktrees/${ids.worktrees.webFeature}` },
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
  { name: "build-data", path: "/build-data" },

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
  { name: "pull-requests", path: "/pull-requests" },
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
  { name: "credentials", path: "/credentials" },
  { name: "settings", path: "/settings" },
];
