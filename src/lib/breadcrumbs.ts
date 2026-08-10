export type BreadcrumbLabelKey =
  | "actionCenter"
  | "actions"
  | "actionsCache"
  | "agents"
  | "analyticsEvents"
  | "apiCache"
  | "apiKeys"
  | "apps"
  | "buildData"
  | "builds"
  | "cache"
  | "changes"
  | "codebases"
  | "comments"
  | "commands"
  | "consoleLogs"
  | "costs"
  | "coverage"
  | "credentials"
  | "devices"
  | "drafts"
  | "edit"
  | "enroll"
  | "entries"
  | "groups"
  | "github"
  | "gitlab"
  | "jira"
  | "mergeRequests"
  | "new"
  | "notifications"
  | "plans"
  | "pipelines"
  | "polling"
  | "provisioningProfiles"
  | "prepare"
  | "pullRequests"
  | "pushNotifications"
  | "repositories"
  | "runs"
  | "sessions"
  | "settings"
  | "skills"
  | "status"
  | "sync"
  | "tickets"
  | "tools"
  | "unifiedEvents"
  | "usage"
  | "users"
  | "webhooks"
  | "workflows"
  | "worktrees";

export type AppBreadcrumb = {
  href?: string;
  isCurrent: boolean;
  label: string;
};

type BreadcrumbTranslator = (key: BreadcrumbLabelKey) => string;

const STATIC_SEGMENTS: Record<string, BreadcrumbLabelKey> = {
  actions: "actions",
  "actions-cache": "actionsCache",
  agents: "agents",
  "analytics-events": "analyticsEvents",
  "api-keys": "apiKeys",
  apps: "apps",
  "build-data": "buildData",
  builds: "builds",
  cache: "cache",
  changes: "changes",
  codebases: "codebases",
  comments: "comments",
  commands: "commands",
  "console-logs": "consoleLogs",
  costs: "costs",
  coverage: "coverage",
  credentials: "credentials",
  devices: "devices",
  drafts: "drafts",
  edit: "edit",
  enroll: "enroll",
  entries: "entries",
  groups: "groups",
  github: "github",
  gitlab: "gitlab",
  "github-cache": "cache",
  jira: "jira",
  "merge-requests": "mergeRequests",
  "jira-cache": "cache",
  "jira-webhooks": "webhooks",
  new: "new",
  notifications: "notifications",
  plans: "plans",
  pipelines: "pipelines",
  polling: "polling",
  "provisioning-profiles": "provisioningProfiles",
  prepare: "prepare",
  "pull-requests": "pullRequests",
  "push-notifications": "pushNotifications",
  repositories: "repositories",
  runs: "runs",
  sessions: "sessions",
  settings: "settings",
  skills: "skills",
  status: "status",
  sync: "sync",
  tickets: "tickets",
  tools: "tools",
  "unified-events": "unifiedEvents",
  usage: "usage",
  users: "users",
  webhooks: "webhooks",
  workflows: "workflows",
  worktrees: "worktrees",
};

const TOP_LEVEL_ALIASES: Record<
  string,
  { href: string; labelKey: BreadcrumbLabelKey }
> = {
  jobs: { href: "/agents", labelKey: "agents" },
  runs: { href: "/drafts", labelKey: "drafts" },
};

const STATIC_NESTED_PATHS = new Set([
  "/codebases/repositories",
  "/commands/new",
  "/commands/runs",
  "/devices/enroll",
  "/gitlab/cache",
  "/gitlab/comments",
  "/gitlab/merge-requests",
  "/gitlab/pipelines",
  "/gitlab/webhooks",
  "/github-cache/entries",
  "/jira-cache/tickets",
  "/jira/tickets",
  "/runs/new",
  "/skills/groups",
  "/skills/sync",
  "/workflows/new",
  "/workflows/runs",
]);

const STATIC_PATH_LABELS: Record<string, BreadcrumbLabelKey> = {
  "/gitlab/cache": "apiCache",
};

const STATIC_NESTED_PATH_PATTERNS = [
  /^\/builds\/[^/]+\/coverage$/,
  /^\/commands\/(?!new(?:\/|$)|runs(?:\/|$))[^/]+\/edit$/,
  /^\/workflows\/(?!new(?:\/|$)|runs(?:\/|$))[^/]+\/edit$/,
];

const ROUTABLE_STATIC_PATHS = new Set([
  "/actions",
  "/actions-cache",
  "/agents",
  "/analytics-events",
  "/api-keys",
  "/apps",
  "/build-data",
  "/builds",
  "/changes",
  "/codebases",
  "/commands",
  "/commands/new",
  "/comments",
  "/console-logs",
  "/costs",
  "/credentials",
  "/devices",
  "/devices/enroll",
  "/drafts",
  "/gitlab/cache",
  "/gitlab/comments",
  "/gitlab/merge-requests",
  "/gitlab/pipelines",
  "/gitlab/webhooks",
  "/github-cache",
  "/jira-cache",
  "/jira/tickets",
  "/notifications",
  "/plans",
  "/polling",
  "/prepare",
  "/provisioning-profiles",
  "/pull-requests",
  "/push-notifications",
  "/sessions",
  "/settings",
  "/status",
  "/skills",
  "/skills/groups",
  "/tools",
  "/unified-events",
  "/usage",
  "/users",
  "/jira-webhooks",
  "/webhooks",
  "/workflows",
  "/workflows/new",
  "/worktrees",
]);

const ROUTABLE_DYNAMIC_PATHS = [
  /^\/apps\/[^/]+$/,
  /^\/agents\/[^/]+$/,
  /^\/builds\/[^/]+$/,
  /^\/codebases\/(?!repositories(?:\/|$))[^/]+$/,
  /^\/devices\/(?!enroll$)[^/]+$/,
  /^\/github-cache\/entries\/[^/]+$/,
  /^\/jira-cache\/tickets\/[^/]+$/,
  /^\/jira\/tickets\/[^/]+$/,
  /^\/plans\/[^/]+$/,
  /^\/provisioning-profiles\/[^/]+$/,
  /^\/sessions\/[^/]+$/,
  /^\/skills\/(?!groups(?:\/|$)|sync(?:\/|$))[^/]+$/,
  /^\/skills\/groups\/[^/]+$/,
  /^\/workflows\/(?!new$|runs(?:\/|$))[^/]+$/,
  /^\/worktrees\/[^/]+$/,
];

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isRoutablePath(path: string): boolean {
  return (
    ROUTABLE_STATIC_PATHS.has(path) ||
    ROUTABLE_DYNAMIC_PATHS.some((pattern) => pattern.test(path))
  );
}

function staticLabelKey(
  segment: string,
  index: number,
  prefix: string,
): BreadcrumbLabelKey | undefined {
  const labelKey = STATIC_SEGMENTS[segment];
  if (!labelKey) return undefined;
  if (index === 0 || STATIC_NESTED_PATHS.has(prefix)) return labelKey;
  return STATIC_NESTED_PATH_PATTERNS.some((pattern) => pattern.test(prefix))
    ? labelKey
    : undefined;
}

export function buildAppBreadcrumbs(
  pathname: string,
  translate: BreadcrumbTranslator,
): AppBreadcrumb[] {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 0) {
    return [{ isCurrent: true, label: translate("actionCenter") }];
  }

  return segments.map((segment, index) => {
    const isCurrent = index === segments.length - 1;
    const alias = index === 0 ? TOP_LEVEL_ALIASES[segment] : undefined;
    const prefix = `/${segments.slice(0, index + 1).join("/")}`;
    const labelKey =
      alias?.labelKey ??
      STATIC_PATH_LABELS[prefix] ??
      staticLabelKey(segment, index, prefix);

    return {
      href: isCurrent
        ? undefined
        : (alias?.href ?? (isRoutablePath(prefix) ? prefix : undefined)),
      isCurrent,
      label: labelKey ? translate(labelKey) : safeDecode(segment),
    };
  });
}
