import { describe, expect, test } from "vitest";

import {
  buildAppBreadcrumbs,
  type BreadcrumbLabelKey,
} from "@/lib/breadcrumbs";

const labels: Record<BreadcrumbLabelKey, string> = {
  actionCenter: "Action Center",
  actions: "Actions",
  actionsCache: "Actions Cache",
  agents: "Agents",
  analyticsEvents: "Analytics Events",
  apiCache: "API Cache",
  apiKeys: "API Keys",
  apps: "Apps",
  buildData: "Build Data",
  builds: "Builds",
  cache: "Cache",
  changes: "Changes",
  codebases: "Codebases",
  comments: "Comments",
  commands: "Commands",
  consoleLogs: "Console Logs",
  costs: "Costs",
  coverage: "Coverage",
  credentials: "Credentials",
  devices: "Devices",
  drafts: "Drafts",
  edit: "Edit",
  enroll: "Enroll",
  entries: "Entries",
  groups: "Groups",
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  mergeRequests: "Merge Requests",
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
  sync: "Sync",
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
  test("returns the localized Action Center crumb for the root route", () => {
    expect(buildAppBreadcrumbs("/", translate)).toEqual([
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
    expect(buildAppBreadcrumbs("/apps/app-123", translate)).toEqual([
      { href: "/apps", isCurrent: false, label: "Apps" },
      { href: undefined, isCurrent: true, label: "app-123" },
    ]);
  });

  test("links the GitHub cache from an entry detail route", () => {
    expect(
      buildAppBreadcrumbs("/github-cache/entries/cache-123", translate),
    ).toEqual([
      { href: "/github-cache", isCurrent: false, label: "Cache" },
      { href: undefined, isCurrent: false, label: "Entries" },
      { href: undefined, isCurrent: true, label: "cache-123" },
    ]);
  });

  test("uses top-level breadcrumbs for provider cache pages", () => {
    expect(buildAppBreadcrumbs("/github-cache", translate)).toEqual([
      { isCurrent: true, label: "Cache" },
    ]);
    expect(buildAppBreadcrumbs("/jira-cache", translate)).toEqual([
      { isCurrent: true, label: "Cache" },
    ]);
  });

  test("localizes newer System destinations", () => {
    expect(buildAppBreadcrumbs("/prepare", translate)).toEqual([
      { isCurrent: true, label: "Prepare" },
    ]);
    expect(buildAppBreadcrumbs("/status", translate)).toEqual([
      { isCurrent: true, label: "Status" },
    ]);
    expect(buildAppBreadcrumbs("/users", translate)).toEqual([
      { isCurrent: true, label: "Users" },
    ]);
    expect(buildAppBreadcrumbs("/api-keys", translate)).toEqual([
      { isCurrent: true, label: "API Keys" },
    ]);
  });

  test("localizes nested GitLab destinations", () => {
    expect(buildAppBreadcrumbs("/gitlab/merge-requests", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "GitLab" },
      { isCurrent: true, label: "Merge Requests" },
    ]);
    expect(buildAppBreadcrumbs("/gitlab/cache", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "GitLab" },
      { isCurrent: true, label: "API Cache" },
    ]);
  });

  test("links the Jira cache from a cached ticket detail route", () => {
    expect(
      buildAppBreadcrumbs("/jira-cache/tickets/APP-123", translate),
    ).toEqual([
      { href: "/jira-cache", isCurrent: false, label: "Cache" },
      { href: undefined, isCurrent: false, label: "Tickets" },
      { href: undefined, isCurrent: true, label: "APP-123" },
    ]);
  });

  test("preserves deep pull request context without invalid links", () => {
    expect(
      buildAppBreadcrumbs("/pull-requests/acme/widgets/42", translate),
    ).toEqual([
      {
        href: "/pull-requests",
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
      buildAppBreadcrumbs("/pull-requests/actions/settings/42", translate),
    ).toEqual([
      {
        href: "/pull-requests",
        isCurrent: false,
        label: "Pull Requests",
      },
      { href: undefined, isCurrent: false, label: "actions" },
      { href: undefined, isCurrent: false, label: "settings" },
      { href: undefined, isCurrent: true, label: "42" },
    ]);
    expect(buildAppBreadcrumbs("/skills/groups/settings", translate)).toEqual([
      { href: "/skills", isCurrent: false, label: "Skills" },
      { href: "/skills/groups", isCurrent: false, label: "Groups" },
      { href: undefined, isCurrent: true, label: "settings" },
    ]);
  });

  test("decodes dynamic identifiers and links real detail ancestors", () => {
    expect(
      buildAppBreadcrumbs("/workflows/release%20workflow/edit", translate),
    ).toEqual([
      { href: "/workflows", isCurrent: false, label: "Workflows" },
      {
        href: "/workflows/release%20workflow",
        isCurrent: false,
        label: "release workflow",
      },
      { href: undefined, isCurrent: true, label: "Edit" },
    ]);
  });

  test("maps top-level route aliases to their navigation destinations", () => {
    expect(buildAppBreadcrumbs("/runs/new", translate)).toEqual([
      { href: "/drafts", isCurrent: false, label: "Drafts" },
      { href: undefined, isCurrent: true, label: "New" },
    ]);
    expect(buildAppBreadcrumbs("/jobs/job-17", translate)).toEqual([
      { href: "/agents", isCurrent: false, label: "Agents" },
      { href: undefined, isCurrent: true, label: "job-17" },
    ]);
  });

  test("falls back safely when a dynamic segment is malformed", () => {
    expect(buildAppBreadcrumbs("/plans/%E0%A4%A", translate).at(-1)).toEqual({
      href: undefined,
      isCurrent: true,
      label: "%E0%A4%A",
    });
  });
});
