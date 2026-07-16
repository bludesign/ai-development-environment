// Mock for next-intl. This file is loaded directly by Vitest aliases, so it
// intentionally remains CommonJS and does not reference vi.
/* eslint-disable @typescript-eslint/no-require-imports */
const React = require("react");

const mockTranslations = {
  metadata: {
    title: "AI Development Environment",
    description: "An AI-focused development environment.",
  },
  common: {
    cancel: "Cancel",
    continue: "Continue",
    cannotBeUndone: "This action cannot be undone.",
  },
  shell: {
    productName: "AI Development Environment",
    welcome: "Welcome",
    dashboard: "Dashboard",
    navigation: "Navigation",
    navigationDescription: "Primary navigation for AI Development Environment.",
    notifications: "Notifications",
    notificationsDescription: "Notification updates and alerts.",
    showNavigation: "Show navigation",
    hideNavigation: "Hide navigation",
    closeNavigation: "Close navigation",
    showNotifications: "Show notifications",
    hideNotifications: "Hide notifications",
    closeNotifications: "Close notifications",
    agents: "Agents",
    github: "GitHub",
    pullRequests: "Pull Requests",
    jira: "Jira",
    tickets: "Tickets",
    cache: "Cache",
    system: "System",
    settings: "Settings",
  },
  agents: {
    title: "Agents",
    description:
      "Manage enrolled Macs and durable jobs from one control plane.",
    refresh: "Refresh",
    enroll: "Enroll agent",
    enrollmentTitle: "One-time enrollment command",
    enrollmentDescription:
      "Run this on the Mac after installing control-agent. The Mac connects outbound; it does not open a listening port.",
    copy: "Copy command",
    copyFailed: "Could not copy the command. Select and copy it manually.",
    expires: "Token expires {date}",
    loading: "Loading agents…",
    emptyTitle: "No agents enrolled",
    emptyDescription: "Create an enrollment command to pair your first Mac.",
    version: "Version",
    platform: "Platform",
    lastSeen: "Last seen",
    never: "Never",
  },
  agentDetail: {
    back: "Agents",
    loading: "Loading agent…",
    notFound: "Agent not found.",
    version: "Version",
    lastSeen: "Last seen",
    never: "Never",
    capabilities: "Capabilities",
    runTitle: "Run Cloudflared Tunnel",
    runDescription:
      "Starts the allow-listed cloudflared handler on this Mac. It keeps running in the agent service when you leave this page.",
    tunnelName: "Tunnel name",
    tunnelPlaceholder: "example-tunnel",
    queuing: "Queuing…",
    run: "Run",
    history: "Job history",
    noJobs: "No jobs have run on this agent.",
  },
  jobs: {
    back: "Agents",
    open: "Open job",
    cancel: "Cancel",
    loading: "Loading job…",
    notFound: "Job not found.",
    waiting: "Waiting for output…",
  },
  jiraTickets: {
    title: "Jira Tickets",
    description:
      "Browse saved Jira projects, boards, and JQL queries by status.",
    refresh: "Refresh",
    manage: "Manage",
    showBoardLayout: "Board layout",
    showTableLayout: "Table layout",
    issueType: "Issue type",
    priority: "Priority",
    loading: "Loading Jira projects…",
    loadingTickets: "Loading tickets…",
    loadingTicket: "Loading ticket details…",
    emptyProjects: "No Jira projects yet",
    emptyProjectsDescription:
      "Configure Jira in Settings, then add a project and its first source.",
    emptySources: "This project has no sources",
    emptySourcesDescription:
      "Add a named JQL query or Jira board URL to load tickets.",
    emptyTickets: "No tickets matched this source.",
    addProject: "Add project",
    addSource: "Add source",
    projectTabs: "Jira projects",
    sourceTabs: "Ticket sources",
    staleWarning:
      "Jira could not be reached, so this view is showing expired cached data.",
    truncatedWarning:
      "This source has more than 1,000 tickets. Refine it to see the remaining results.",
    issue: "Issue",
    unassigned: "Unassigned",
    manageTitle: "Manage Jira projects and sources",
    manageDescription:
      "Projects come from Jira. Each source is validated before it is saved.",
    projects: "Projects",
    availableProjects: "Available Jira projects",
    selectProject: "Select a project",
    sourceCount: "{count} sources",
    removeProject: "Remove project",
    confirmRemoveProject: "Remove this project and all of its saved sources?",
    sourcesFor: "Sources for {project}",
    displaySettings: "Display settings",
    displaySettingsDescription: "These settings apply only to this project.",
    ticketsToShow: "Tickets to show",
    allTickets: "All tickets",
    unassignedOrSelfAssigned: "Unassigned or assigned to me",
    selfAssignedInProgress: "My in-progress tickets",
    hideCompletedTickets: "Hide completed tickets",
    hideCompletedTicketsDescription:
      "Choose which project statuses count as completed.",
    completedStatuses: "Completed statuses",
    loadingStatuses: "Loading statuses…",
    selectCompletedStatuses: "Select completed statuses",
    saveDisplaySettings: "Save display settings",
    sourceName: "Source name",
    sourceType: "Source type",
    boardUrl: "Board URL",
    editSource: "Edit source",
    deleteSource: "Delete source",
    confirmDeleteSource: "Delete this source and its related cache entries?",
    saveSource: "Save source",
    cancel: "Cancel",
    done: "Done",
    ticket: "Ticket",
    staleTicket: "Some ticket data is stale because Jira could not be reached.",
    openInJira: "Open in Jira",
    descriptionTitle: "Description",
    classification: "Classification",
    labels: "Labels",
    components: "Components",
    fixVersions: "Fix versions",
    sprints: "Sprints",
    relatedIssues: "Related issues",
    attachments: "Attachments",
    comments: "Comments ({count})",
    noComments: "No comments on this ticket.",
    unknownUser: "Unknown user",
    assignee: "Assignee",
    reporter: "Reporter",
    created: "Created",
    updated: "Updated",
    due: "Due",
    resolved: "Resolved",
  },
  jiraCache: {
    title: "Jira Cache",
    description: "Inspect cached Jira data, API usage, latency, and errors.",
    ttl: "Cache TTL in minutes",
    saveTtl: "Save TTL",
    clearCache: "Clear cache",
    confirmClear:
      "Clear every Jira response and cached ticket? API call history will be kept.",
    loading: "Loading cache activity…",
    average: "Average {ms} ms",
    live: "Live",
    cache: "Cache",
    errors: "Errors",
    operationsTitle: "API operations",
    operationsDescription:
      "Counts by operation and result source for each rolling window.",
    noMetrics: "No Jira API activity in the last 24 hours.",
    operation: "Operation",
    recentTitle: "Recent API calls",
    recentDescription: "Every cached Jira SDK operation, newest first.",
    noCalls: "No Jira API calls have been recorded.",
    time: "Time",
    fetched: "What was fetched",
    source: "Source",
    duration: "Duration",
    error: "Error",
    stale: "Stale",
    ticketsTitle: "Cached tickets",
    ticketsDescription:
      "Materialized summary, detail, and comment coverage for Jira issues.",
    noTickets: "No Jira tickets are cached.",
    ticket: "Ticket",
    status: "Status",
    coverage: "Coverage",
    freshness: "Freshness",
    fresh: "Fresh",
    lastFetched: "Last fetched",
    actions: "Actions",
    open: "Open",
    refresh: "Refresh",
    delete: "Delete",
    confirmDeleteTicket:
      "Delete {issueKey} and every cache entry that references it?",
    showing: "Showing {start}–{end} of {total}",
    previous: "Previous",
    next: "Next",
  },
  jiraCacheDetail: {
    back: "Jira Cache",
    description: "Cached Jira ticket data",
    refresh: "Refresh ticket",
    delete: "Delete from cache",
    confirmDelete: "Delete {issueKey} and its related cache entries?",
    loading: "Loading cached ticket…",
    notFound: "This ticket is not in the Jira cache.",
    coverage: "Coverage",
    freshness: "Freshness",
    fresh: "Fresh",
    stale: "Stale",
    detailFetched: "Detail fetched",
    commentsFetched: "Comments fetched",
    summaryData: "Summary response",
    detailData: "Full detail response",
    commentsData: "Complete comments response",
    notFetched: "This data level has not been fetched.",
    relatedEntries: "Related cache entries",
    noEntries: "No cache entries reference this ticket.",
    operation: "Operation",
    fetchedAt: "Fetched at",
    entryId: "Cache entry ID",
  },
  jiraSettings: {
    title: "Settings",
    description: "Configure the Jira Cloud account used by this application.",
    loading: "Loading Jira settings…",
    credentials: "Jira credentials",
    configured: "Token configured",
    notConfigured: "Token not configured",
    siteUrl: "Jira Cloud site URL",
    siteUrlHelp: "Use the base *.atlassian.net URL for your Jira site.",
    email: "Jira account email",
    apiToken: "Jira API token",
    tokenPlaceholder: "Paste an Atlassian API token",
    tokenPlaceholderConfigured: "Leave blank to keep the saved token",
    tokenHelp:
      "The token is stored in the local SQLite database and is never returned to the browser.",
    tokenKeepHelp:
      "Leave this blank unless you want to replace the saved token.",
    save: "Save settings",
    test: "Test connection",
    remove: "Remove credentials",
    saved: "Jira settings saved.",
    connectionSucceeded: "Jira connection succeeded.",
    removed: "Jira credentials removed and cached Jira data cleared.",
    confirmSiteChange:
      "Changing the Jira site removes all saved Jira projects, sources, and cached data. Continue?",
    confirmRemove:
      "Remove the saved email and API token and clear cached Jira data?",
  },
  settings: {
    title: "Settings",
    description: "Configure the integrations used by this application.",
  },
  githubSettings: {
    title: "GitHub credentials",
    description: "Connect the account used to load pull requests.",
    loading: "Loading GitHub settings…",
    configured: "Token configured",
    notConfigured: "Token not configured",
    apiToken: "GitHub personal access token",
    tokenPlaceholder: "Paste a GitHub personal access token",
    tokenPlaceholderConfigured: "Leave blank to keep the saved token",
    tokenHelp:
      "Grant read access to the repositories and pull requests you want to display.",
    tokenKeepHelp:
      "Leave this blank unless you want to replace the saved token.",
    save: "Save settings",
    test: "Test connection",
    remove: "Remove credentials",
    saved: "GitHub settings saved.",
    connectionSucceeded: "GitHub connection succeeded.",
    removed: "GitHub credentials removed. Managed repositories were kept.",
    confirmRemove: "Remove GitHub credentials?",
    confirmRemoveDescription:
      "The saved token will be removed. Managed repository and Jira regex settings will be kept.",
  },
  pullRequests: {
    title: "Pull Requests",
    description:
      "Review your GitHub pull requests and monitored repositories in one place.",
    refresh: "Refresh",
    manage: "Manage",
    loading: "Loading GitHub configuration…",
    credentialsRequired: "Connect GitHub to view pull requests",
    credentialsRequiredDescription:
      "Add a personal access token in Settings before loading GitHub data.",
    openSettings: "Open Settings",
    tabsLabel: "Pull request views",
    mine: "Mine",
    reviewRequests: "Review requests",
    truncated:
      "GitHub search returns at most 1,000 results. Refine your workload on GitHub to see anything beyond this limit.",
    loadingPullRequests: "Loading pull requests…",
    empty: "No open pull requests",
    emptyDescription: "No pull requests currently match this view.",
    repository: "Repository",
    number: "Number",
    pullRequest: "Pull request",
    labels: "Labels",
    jira: "Jira",
    pipeline: "Pipeline",
    approval: "Approval",
    openComments: "Open comments",
    age: "Age",
    pipelineStates: {
      ERROR: "Error",
      EXPECTED: "Expected",
      FAILURE: "Failed",
      PENDING: "Pending",
      SUCCESS: "Passed",
      NONE: "No checks",
    },
    reviewStates: {
      APPROVED: "Approved",
      CHANGES_REQUESTED: "Changes requested",
      REVIEW_REQUIRED: "Review required",
      NONE: "No decision",
    },
    manageTitle: "Manage GitHub repositories",
    manageDescription:
      "Choose repository tabs and configure how Jira keys are parsed from pull request titles.",
    manageCredentialsRequired:
      "Configure GitHub credentials before adding repositories.",
    managedRepositories: "Managed repositories",
    noManagedRepositories: "No repositories are managed yet.",
    addRepository: "Add repository",
    browse: "Browse",
    enterManually: "Enter manually",
    privateRepository: "Private repository",
    managed: "Managed",
    add: "Add",
    loadingRepositories: "Loading repositories…",
    loadMore: "Load more",
    repositoryName: "Repository owner/name",
    jiraKeyRegex: "Jira key regex",
    jiraKeyRegexHelp:
      "The first capture group is used when present; otherwise the entire match is used. Clear this field to disable Jira key parsing.",
    invalidRegex: "Enter a valid Jira key regular expression.",
    done: "Done",
    removeRepository: "Remove repository",
    confirmRemoveRepository: "Remove this managed repository?",
    confirmRemoveRepositoryDescription:
      "Its pull request tab and Jira regex configuration will be removed.",
    saveRegex: "Save Jira regex",
  },
  status: {
    online: "online",
    offline: "offline",
    queued: "queued",
    running: "running",
    succeeded: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
    timed_out: "timed out",
  },
};

const useTranslations = (namespace) => {
  return (key, values) => {
    const namespaceParts = namespace ? namespace.split(".") : [];
    let namespaceTranslations = mockTranslations;

    for (const part of namespaceParts) {
      namespaceTranslations = Object.prototype.hasOwnProperty.call(
        namespaceTranslations,
        part,
      )
        ? namespaceTranslations[part]
        : {};
    }

    const keyParts = key.split(".");
    let translation = namespaceTranslations;

    for (const keyPart of keyParts) {
      translation =
        translation &&
        Object.prototype.hasOwnProperty.call(translation, keyPart)
          ? translation[keyPart]
          : null;
    }

    if (!translation) {
      translation = namespace ? `${namespace}.${key}` : key;
    }

    if (values && typeof translation === "string") {
      for (const [valueKey, value] of Object.entries(values)) {
        translation = translation.replaceAll(`{${valueKey}}`, String(value));
      }
    }

    return translation;
  };
};

const NextIntlClientProvider = ({ children }) => children;
const useLocale = () => "en";
const hasLocale = (supportedLocales, locale) =>
  typeof locale === "string" && supportedLocales.includes(locale);
const mockPush = () => {};
const mockReplace = () => {};
const useRouter = () => ({
  push: mockPush,
  replace: mockReplace,
  prefetch: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
});
const usePathname = () => "/";
const Link = ({ children, href, ...props }) =>
  React.createElement("a", { href, ...props }, children);
const defineRouting = (config) => config;
const createNavigation = () => ({
  Link,
  redirect: () => {},
  useRouter,
  usePathname,
  getPathname: () => "/",
});

module.exports = {
  mockTranslations,
  useTranslations,
  NextIntlClientProvider,
  useLocale,
  hasLocale,
  useRouter,
  usePathname,
  Link,
  defineRouting,
  createNavigation,
  mockPush,
  mockReplace,
};
