export type BreadcrumbLabelKey =
  | "actions"
  | "actionsCache"
  | "agents"
  | "analyticsEvents"
  | "buildData"
  | "builds"
  | "cache"
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
  | "jira"
  | "new"
  | "notifications"
  | "plans"
  | "polling"
  | "provisioningProfiles"
  | "pullRequests"
  | "pushNotifications"
  | "repositories"
  | "runs"
  | "sessions"
  | "settings"
  | "skills"
  | "sync"
  | "tickets"
  | "tools"
  | "unifiedEvents"
  | "usage"
  | "welcome"
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
  "build-data": "buildData",
  builds: "builds",
  cache: "cache",
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
  jira: "jira",
  new: "new",
  notifications: "notifications",
  plans: "plans",
  polling: "polling",
  "provisioning-profiles": "provisioningProfiles",
  "pull-requests": "pullRequests",
  "push-notifications": "pushNotifications",
  repositories: "repositories",
  runs: "runs",
  sessions: "sessions",
  settings: "settings",
  skills: "skills",
  sync: "sync",
  tickets: "tickets",
  tools: "tools",
  "unified-events": "unifiedEvents",
  usage: "usage",
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
  "/github/cache",
  "/github/cache/entries",
  "/jira/cache",
  "/jira/cache/tickets",
  "/jira/tickets",
  "/runs/new",
  "/skills/groups",
  "/skills/sync",
  "/workflows/new",
  "/workflows/runs",
]);

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
  "/build-data",
  "/builds",
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
  "/github/cache",
  "/jira/cache",
  "/jira/tickets",
  "/notifications",
  "/plans",
  "/polling",
  "/provisioning-profiles",
  "/pull-requests",
  "/push-notifications",
  "/sessions",
  "/settings",
  "/skills",
  "/skills/groups",
  "/tools",
  "/unified-events",
  "/usage",
  "/workflows",
  "/workflows/new",
  "/worktrees",
]);

const ROUTABLE_DYNAMIC_PATHS = [
  /^\/agents\/[^/]+$/,
  /^\/builds\/[^/]+$/,
  /^\/codebases\/(?!repositories(?:\/|$))[^/]+$/,
  /^\/devices\/(?!enroll$)[^/]+$/,
  /^\/github\/cache\/entries\/[^/]+$/,
  /^\/jira\/cache\/tickets\/[^/]+$/,
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
    return [{ isCurrent: true, label: translate("welcome") }];
  }

  return segments.map((segment, index) => {
    const isCurrent = index === segments.length - 1;
    const alias = index === 0 ? TOP_LEVEL_ALIASES[segment] : undefined;
    const prefix = `/${segments.slice(0, index + 1).join("/")}`;
    const labelKey = alias?.labelKey ?? staticLabelKey(segment, index, prefix);

    return {
      href: isCurrent
        ? undefined
        : (alias?.href ?? (isRoutablePath(prefix) ? prefix : undefined)),
      isCurrent,
      label: labelKey ? translate(labelKey) : safeDecode(segment),
    };
  });
}
