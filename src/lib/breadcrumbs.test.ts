import { describe, expect, test } from "vitest";
import { globSync } from "node:fs";

import {
  buildAppBreadcrumbs,
  type BreadcrumbLabelKey,
} from "@/lib/breadcrumbs";

const labels: Record<BreadcrumbLabelKey, string> = {
  actionCenter: "Action Center",
  actions: "Actions",
  actionsCache: "Actions Cache",
  agents: "Agents",
  ai: "AI",
  analyticsEvents: "Analytics Events",
  apiKeys: "API Keys",
  apps: "Apps",
  buildData: "Build Data",
  builds: "Builds",
  breakpoints: "Breakpoints",
  cache: "Cache",
  changes: "Changes",
  codebases: "Codebases",
  comments: "Comments",
  commands: "Commands",
  configurations: "Configurations",
  consoleLogs: "Console Logs",
  costs: "Costs",
  coverage: "Coverage",
  crashes: "Crashes",
  credentials: "Credentials",
  dashboard: "Dashboard",
  debugging: "Debugging",
  devices: "Devices",
  drafts: "Drafts",
  dsyms: "dSYMs",
  edit: "Edit",
  enroll: "Enroll",
  entries: "Entries",
  groups: "Groups",
  history: "History",
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  mergeRequests: "Merge Requests",
  mocks: "Mocks",
  new: "New",
  notifications: "Notifications",
  plans: "Plans",
  pipelines: "Pipelines",
  polling: "Polling",
  provisioningProfiles: "Provisioning Profiles",
  prepare: "Prepare",
  pullRequests: "Pull Requests",
  pushNotifications: "Push Notifications",
  repositories: "Repositories",
  runs: "Runs",
  sessions: "Sessions",
  settings: "Settings",
  skills: "Skills",
  status: "Status",
  scriptStorage: "Script Storage",
  sync: "Sync",
  system: "System",
  sseEndpoints: "SSE Endpoints",
  tailscale: "Tailscale",
  tickets: "Tickets",
  tools: "Tools",
  unifiedEvents: "Unified View",
  usage: "Usage",
  users: "Users",
  webhooks: "Webhooks",
  workflows: "Workflows",
  worktrees: "Worktrees",
};

const translate = (key: BreadcrumbLabelKey) => labels[key];

describe("buildAppBreadcrumbs", () => {
  test("uses loaded ancestor titles while retaining nested page labels and links", () => {
    expect(
      buildAppBreadcrumbs("/dashboard/workflows/workflow-id/edit", translate, {
        "/dashboard/workflows/workflow-id": "Release workflow",
        "/dashboard/workflows/other-id": "Other workflow",
      }),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "Dashboard" },
      { href: "/dashboard/workflows", isCurrent: false, label: "Workflows" },
      {
        href: "/dashboard/workflows/workflow-id",
        isCurrent: false,
        label: "Release workflow",
      },
      { href: undefined, isCurrent: true, label: "Edit" },
    ]);
  });

  test("resolves all dynamic levels of a merge request without inventing parent links", () => {
    expect(
      buildAppBreadcrumbs("/gitlab/merge-requests/123/42", translate, {
        "/gitlab/merge-requests/123": "acme/mobile",
        "/gitlab/merge-requests/123/42": "Fix sign in",
      }),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "GitLab" },
      {
        href: "/gitlab/merge-requests",
        isCurrent: false,
        label: "Merge Requests",
      },
      { href: undefined, isCurrent: false, label: "acme/mobile" },
      { href: undefined, isCurrent: true, label: "Fix sign in" },
    ]);
  });

  test("localizes every static segment in the dashboard routes", () => {
    for (const page of globSync("**/page.tsx", {
      cwd: "src/app/[locale]/(dashboard)",
    })) {
      const segments = page.split("/").slice(0, -1);
      const pathname = `/${segments.map((segment) => (segment.startsWith("[") ? "record-123" : segment)).join("/")}`;
      const breadcrumbs = buildAppBreadcrumbs(
        pathname,
        (key) => `translated:${key}`,
      );
      segments.forEach((segment, index) => {
        if (!segment.startsWith("[")) {
          expect(breadcrumbs[index].label, pathname).toMatch(/^translated:/);
        }
      });
    }
  });

  test("returns Dashboard and Action Center for the home page", () => {
    expect(buildAppBreadcrumbs("/dashboard/action-center", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "Dashboard" },
      { isCurrent: true, label: "Action Center" },
    ]);
  });

  test("links only valid ancestors in a nested Jira route", () => {
    expect(buildAppBreadcrumbs("/jira/tickets/APP-123", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "Jira" },
      { href: "/jira/tickets", isCurrent: false, label: "Tickets" },
      { href: undefined, isCurrent: true, label: "APP-123" },
    ]);
  });

  test("links the Apps index from an app detail route", () => {
    expect(buildAppBreadcrumbs("/dashboard/apps/app-123", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "Dashboard" },
      { href: "/dashboard/apps", isCurrent: false, label: "Apps" },
      { href: undefined, isCurrent: true, label: "app-123" },
    ]);
  });

  test("links the Configurations tab from a build configuration detail route", () => {
    expect(
      buildAppBreadcrumbs(
        "/dashboard/builds/configurations/configuration-123",
        translate,
      ),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "Dashboard" },
      { href: "/dashboard/builds", isCurrent: false, label: "Builds" },
      {
        href: "/dashboard/builds?view=configurations",
        isCurrent: false,
        label: "Configurations",
      },
      { href: undefined, isCurrent: true, label: "configuration-123" },
    ]);
  });

  test("links the crash and dSYM lists from their detail routes", () => {
    expect(
      buildAppBreadcrumbs("/debugging/crashes/crash-123", translate),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "Debugging" },
      { href: "/debugging/crashes", isCurrent: false, label: "Crashes" },
      { href: undefined, isCurrent: true, label: "crash-123" },
    ]);
    expect(
      buildAppBreadcrumbs("/debugging/crashes/dsyms/dsym-123", translate),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "Debugging" },
      { href: "/debugging/crashes", isCurrent: false, label: "Crashes" },
      { href: "/debugging/crashes/dsyms", isCurrent: false, label: "dSYMs" },
      { href: undefined, isCurrent: true, label: "dsym-123" },
    ]);
  });

  test("links the GitHub cache from an entry detail route", () => {
    expect(
      buildAppBreadcrumbs("/github/cache/entries/cache-123", translate),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "GitHub" },
      { href: "/github/cache", isCurrent: false, label: "Cache" },
      { href: undefined, isCurrent: false, label: "Entries" },
      { href: undefined, isCurrent: true, label: "cache-123" },
    ]);
  });

  test("includes the provider in cache breadcrumbs", () => {
    expect(buildAppBreadcrumbs("/github/cache", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "GitHub" },
      { isCurrent: true, label: "Cache" },
    ]);
    expect(buildAppBreadcrumbs("/jira/cache", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "Jira" },
      { isCurrent: true, label: "Cache" },
    ]);
  });

  test("localizes newer System destinations", () => {
    expect(buildAppBreadcrumbs("/system/prepare", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "System" },
      { isCurrent: true, label: "Prepare" },
    ]);
    expect(buildAppBreadcrumbs("/system/status", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "System" },
      { isCurrent: true, label: "Status" },
    ]);
    expect(buildAppBreadcrumbs("/system/users", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "System" },
      { isCurrent: true, label: "Users" },
    ]);
    expect(buildAppBreadcrumbs("/system/api-keys", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "System" },
      { isCurrent: true, label: "API Keys" },
    ]);
    expect(buildAppBreadcrumbs("/system/tailscale", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "System" },
      { isCurrent: true, label: "Tailscale" },
    ]);
  });

  test("localizes nested GitLab destinations", () => {
    expect(buildAppBreadcrumbs("/gitlab/merge-requests", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "GitLab" },
      { isCurrent: true, label: "Merge Requests" },
    ]);
    expect(buildAppBreadcrumbs("/gitlab/cache", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "GitLab" },
      { isCurrent: true, label: "Cache" },
    ]);
  });

  test("links the Jira cache from a cached ticket detail route", () => {
    expect(
      buildAppBreadcrumbs("/jira/cache/tickets/APP-123", translate),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "Jira" },
      { href: "/jira/cache", isCurrent: false, label: "Cache" },
      { href: undefined, isCurrent: false, label: "Tickets" },
      { href: undefined, isCurrent: true, label: "APP-123" },
    ]);
  });

  test("preserves deep pull request context without invalid links", () => {
    expect(
      buildAppBreadcrumbs("/github/pull-requests/acme/widgets/42", translate),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "GitHub" },
      {
        href: "/github/pull-requests",
        isCurrent: false,
        label: "Pull Requests",
      },
      { href: undefined, isCurrent: false, label: "acme" },
      { href: undefined, isCurrent: false, label: "widgets" },
      { href: undefined, isCurrent: true, label: "42" },
    ]);
  });

  test("does not translate dynamic identifiers that match static segments", () => {
    expect(
      buildAppBreadcrumbs(
        "/github/pull-requests/actions/settings/42",
        translate,
      ),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "GitHub" },
      {
        href: "/github/pull-requests",
        isCurrent: false,
        label: "Pull Requests",
      },
      { href: undefined, isCurrent: false, label: "actions" },
      { href: undefined, isCurrent: false, label: "settings" },
      { href: undefined, isCurrent: true, label: "42" },
    ]);
    expect(
      buildAppBreadcrumbs("/ai/skills/groups/settings", translate),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "AI" },
      { href: "/ai/skills", isCurrent: false, label: "Skills" },
      { href: "/ai/skills/groups", isCurrent: false, label: "Groups" },
      { href: undefined, isCurrent: true, label: "settings" },
    ]);
  });

  test("decodes dynamic identifiers and links real detail ancestors", () => {
    expect(
      buildAppBreadcrumbs(
        "/dashboard/workflows/release%20workflow/edit",
        translate,
      ),
    ).toEqual([
      { href: undefined, isCurrent: false, label: "Dashboard" },
      { href: "/dashboard/workflows", isCurrent: false, label: "Workflows" },
      {
        href: "/dashboard/workflows/release%20workflow",
        isCurrent: false,
        label: "release workflow",
      },
      { href: undefined, isCurrent: true, label: "Edit" },
    ]);
  });

  test("maps top-level route aliases to their navigation destinations", () => {
    expect(buildAppBreadcrumbs("/ai/drafts/new", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "AI" },
      { href: "/ai/drafts", isCurrent: false, label: "Drafts" },
      { href: undefined, isCurrent: true, label: "New" },
    ]);
    expect(buildAppBreadcrumbs("/dashboard/jobs/job-17", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "Dashboard" },
      { href: "/dashboard/agents", isCurrent: false, label: "Agents" },
      { href: undefined, isCurrent: true, label: "job-17" },
    ]);
  });

  test("falls back safely when a dynamic segment is malformed", () => {
    expect(buildAppBreadcrumbs("/ai/plans/%E0%A4%A", translate).at(-1)).toEqual(
      {
        href: undefined,
        isCurrent: true,
        label: "%E0%A4%A",
      },
    );
  });
});
