import {
  APP_DESTINATIONS,
  type NavigationSection,
} from "@/lib/app-destinations";

export type BreadcrumbLabelKey =
  | NavigationSection
  | "actionCenter"
  | "actions"
  | "actionsCache"
  | "agents"
  | "analyticsEvents"
  | "apiKeys"
  | "apps"
  | "buildData"
  | "builds"
  | "breakpoints"
  | "cache"
  | "changes"
  | "codebases"
  | "comments"
  | "commands"
  | "configurations"
  | "consoleLogs"
  | "costs"
  | "coverage"
  | "crashes"
  | "credentials"
  | "devices"
  | "drafts"
  | "dsyms"
  | "edit"
  | "enroll"
  | "entries"
  | "groups"
  | "history"
  | "github"
  | "gitlab"
  | "jira"
  | "mergeRequests"
  | "mocks"
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
  | "scriptStorage"
  | "sync"
  | "sseEndpoints"
  | "tailscale"
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
  "action-center": "actionCenter",
  ai: "ai",
  actions: "actions",
  "actions-cache": "actionsCache",
  agents: "agents",
  "analytics-events": "analyticsEvents",
  "api-keys": "apiKeys",
  apps: "apps",
  "build-data": "buildData",
  builds: "builds",
  breakpoints: "breakpoints",
  cache: "cache",
  changes: "changes",
  codebases: "codebases",
  comments: "comments",
  commands: "commands",
  configurations: "configurations",
  "console-logs": "consoleLogs",
  costs: "costs",
  coverage: "coverage",
  crashes: "crashes",
  credentials: "credentials",
  dashboard: "dashboard",
  debugging: "debugging",
  devices: "devices",
  drafts: "drafts",
  dsyms: "dsyms",
  edit: "edit",
  enroll: "enroll",
  entries: "entries",
  groups: "groups",
  history: "history",
  github: "github",
  gitlab: "gitlab",
  jira: "jira",
  "merge-requests": "mergeRequests",
  mocks: "mocks",
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
  storage: "scriptStorage",
  skills: "skills",
  status: "status",
  sync: "sync",
  system: "system",
  sse: "sseEndpoints",
  tailscale: "tailscale",
  tickets: "tickets",
  tools: "tools",
  "unified-events": "unifiedEvents",
  usage: "usage",
  users: "users",
  webhooks: "webhooks",
  workflows: "workflows",
  worktrees: "worktrees",
};

const STATIC_PATH_ALIASES: Record<
  string,
  { href: string; labelKey: BreadcrumbLabelKey }
> = {
  "/dashboard/jobs": { href: "/dashboard/agents", labelKey: "agents" },
};

const STATIC_NESTED_PATHS = new Set([
  ...APP_DESTINATIONS.map((destination) => destination.href),
  "/dashboard/builds/configurations",
  "/dashboard/codebases/repositories",
  "/dashboard/commands/new",
  "/dashboard/commands/runs",
  "/debugging/crashes/dsyms",
  "/system/devices/enroll",
  "/gitlab/cache",
  "/gitlab/comments",
  "/gitlab/merge-requests",
  "/gitlab/pipelines",
  "/gitlab/webhooks",
  "/github/cache/entries",
  "/jira/cache/tickets",
  "/jira/tickets",
  "/ai/drafts/new",
  "/ai/skills/groups",
  "/ai/skills/sync",
  "/debugging/sse/breakpoints",
  "/debugging/sse/history",
  "/debugging/sse/mocks",
  "/debugging/sse/new",
  "/debugging/sse/storage",
  "/dashboard/workflows/new",
  "/dashboard/workflows/runs",
]);

const STATIC_PATH_LINKS: Record<string, string> = {
  "/dashboard/builds/configurations": "/dashboard/builds?view=configurations",
};

const STATIC_NESTED_PATH_PATTERNS = [
  /^\/dashboard\/builds\/[^/]+\/coverage$/,
  /^\/dashboard\/commands\/(?!new(?:\/|$)|runs(?:\/|$))[^/]+\/edit$/,
  /^\/dashboard\/workflows\/(?!new(?:\/|$)|runs(?:\/|$))[^/]+\/edit$/,
  /^\/debugging\/sse\/(?!new(?:\/|$)|breakpoints(?:\/|$)|history(?:\/|$)|storage(?:\/|$))[^/]+\/mocks$/,
];

const ROUTABLE_STATIC_PATHS = new Set([
  "/dashboard/action-center",
  "/github/actions",
  "/github/actions-cache",
  "/dashboard/agents",
  "/debugging/analytics-events",
  "/system/api-keys",
  "/dashboard/apps",
  "/system/build-data",
  "/dashboard/builds",
  "/dashboard/changes",
  "/dashboard/codebases",
  "/dashboard/commands",
  "/dashboard/commands/new",
  "/github/comments",
  "/debugging/console-logs",
  "/ai/costs",
  "/debugging/crashes",
  "/debugging/crashes/dsyms",
  "/system/credentials",
  "/system/devices",
  "/system/devices/enroll",
  "/ai/drafts",
  "/gitlab/cache",
  "/gitlab/comments",
  "/gitlab/merge-requests",
  "/gitlab/pipelines",
  "/gitlab/webhooks",
  "/github/cache",
  "/jira/cache",
  "/jira/tickets",
  "/dashboard/notifications",
  "/ai/plans",
  "/system/polling",
  "/system/prepare",
  "/system/provisioning-profiles",
  "/github/pull-requests",
  "/debugging/push-notifications",
  "/ai/sessions",
  "/debugging/sse",
  "/debugging/sse/breakpoints",
  "/debugging/sse/history",
  "/debugging/sse/new",
  "/debugging/sse/storage",
  "/system/settings",
  "/system/status",
  "/system/tailscale",
  "/ai/skills",
  "/ai/skills/groups",
  "/system/tools",
  "/debugging/unified-events",
  "/ai/usage",
  "/system/users",
  "/jira/webhooks",
  "/github/webhooks",
  "/dashboard/workflows",
  "/dashboard/workflows/new",
  "/dashboard/worktrees",
]);

const ROUTABLE_DYNAMIC_PATHS = [
  /^\/dashboard\/apps\/[^/]+$/,
  /^\/dashboard\/agents\/[^/]+$/,
  /^\/dashboard\/builds\/(?!configurations$)[^/]+$/,
  /^\/dashboard\/codebases\/(?!repositories(?:\/|$))[^/]+$/,
  /^\/debugging\/crashes\/(?!dsyms$)[^/]+$/,
  /^\/debugging\/crashes\/dsyms\/[^/]+$/,
  /^\/system\/devices\/(?!enroll$)[^/]+$/,
  /^\/github\/cache\/entries\/[^/]+$/,
  /^\/jira\/cache\/tickets\/[^/]+$/,
  /^\/jira\/tickets\/[^/]+$/,
  /^\/ai\/plans\/[^/]+$/,
  /^\/system\/provisioning-profiles\/[^/]+$/,
  /^\/ai\/sessions\/[^/]+$/,
  /^\/debugging\/sse\/(?!new$|breakpoints$|history$|storage$)[^/]+$/,
  /^\/debugging\/sse\/(?!new$|breakpoints$|history$|storage$)[^/]+\/mocks$/,
  /^\/ai\/skills\/(?!groups(?:\/|$)|sync(?:\/|$))[^/]+$/,
  /^\/ai\/skills\/groups\/[^/]+$/,
  /^\/dashboard\/workflows\/(?!new$|runs(?:\/|$))[^/]+$/,
  /^\/dashboard\/worktrees\/[^/]+$/,
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
  labels: Readonly<Record<string, string>> = {},
): AppBreadcrumb[] {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  const segments = path.split("/").filter(Boolean);

  const breadcrumbs: AppBreadcrumb[] = segments.map((segment, index) => {
    const isCurrent = index === segments.length - 1;
    const prefix = `/${segments.slice(0, index + 1).join("/")}`;
    const alias = STATIC_PATH_ALIASES[prefix];
    const labelKey = alias?.labelKey ?? staticLabelKey(segment, index, prefix);
    const labelPath = `/${segments
      .slice(0, index + 1)
      .map((part) => encodeURIComponent(safeDecode(part)))
      .join("/")}`;

    return {
      href: isCurrent
        ? undefined
        : (alias?.href ??
          STATIC_PATH_LINKS[prefix] ??
          (isRoutablePath(prefix) ? prefix : undefined)),
      isCurrent,
      label:
        labels[labelPath] ??
        (labelKey ? translate(labelKey) : safeDecode(segment)),
    };
  });

  if (breadcrumbs.length === 0) {
    breadcrumbs.push({ isCurrent: true, label: translate("actionCenter") });
  }

  return breadcrumbs;
}
