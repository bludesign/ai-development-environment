import { describe, expect, test } from "vitest";

import {
  buildAppBreadcrumbs,
  type BreadcrumbLabelKey,
} from "@/lib/breadcrumbs";

const labels: Record<BreadcrumbLabelKey, string> = {
  actions: "Actions",
  actionsCache: "Actions Cache",
  agents: "Agents",
  analyticsEvents: "Analytics Events",
  buildData: "Build Data",
  builds: "Builds",
  cache: "Cache",
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
  groups: "Groups",
  jira: "Jira",
  new: "New",
  notifications: "Notifications",
  plans: "Plans",
  polling: "Polling",
  provisioningProfiles: "Provisioning Profiles",
  pullRequests: "Pull Requests",
  pushNotifications: "Push Notifications",
  repositories: "Repositories",
  runs: "Runs",
  sessions: "Sessions",
  settings: "Settings",
  skills: "Skills",
  sync: "Sync",
  tickets: "Tickets",
  tools: "Tools",
  unifiedEvents: "Unified View",
  usage: "Usage",
  welcome: "Welcome",
  workflows: "Workflows",
  worktrees: "Worktrees",
};

const translate = (key: BreadcrumbLabelKey) => labels[key];

describe("buildAppBreadcrumbs", () => {
  test("returns the localized welcome crumb for the root route", () => {
    expect(buildAppBreadcrumbs("/", translate)).toEqual([
      { isCurrent: true, label: "Welcome" },
    ]);
  });

  test("links only valid ancestors in a nested Jira route", () => {
    expect(buildAppBreadcrumbs("/jira/tickets/APP-123", translate)).toEqual([
      { href: undefined, isCurrent: false, label: "Jira" },
      { href: "/jira/tickets", isCurrent: false, label: "Tickets" },
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
