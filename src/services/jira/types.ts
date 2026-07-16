export type JiraSourceKind = "JQL" | "BOARD";
export type JiraCallSource = "LIVE" | "CACHE" | "ERROR";

export type JiraSettingsView = {
  siteUrl: string | null;
  email: string | null;
  tokenConfigured: boolean;
  cacheTtlSeconds: number;
  updatedAt: string;
};

export type JiraSourceView = {
  id: string;
  projectId: string;
  name: string;
  kind: JiraSourceKind;
  value: string;
  boardId: number | null;
  position: number;
};

export type JiraProjectView = {
  id: string;
  jiraId: string;
  key: string;
  name: string;
  avatarUrl: string | null;
  position: number;
  sources: JiraSourceView[];
};

export type JiraAvailableProject = {
  jiraId: string;
  key: string;
  name: string;
  avatarUrl: string | null;
};

export type JiraCacheMeta = {
  source: JiraCallSource;
  stale: boolean;
  fetchedAt: string;
};

export type JiraTicketSummary = {
  id: string;
  key: string;
  summary: string;
  statusId: string;
  status: string;
  statusCategory: string;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  assigneeAvatarUrl: string | null;
  projectKey: string;
  updatedAt: string | null;
};

export type JiraTicketBoard = {
  source: JiraSourceView;
  tickets: JiraTicketSummary[];
  statusOrder: string[];
  cache: JiraCacheMeta;
  truncated: boolean;
  warnings: string[];
};

export type JiraPerson = {
  accountId: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type JiraCommentView = {
  id: string;
  author: JiraPerson | null;
  body: unknown;
  createdAt: string | null;
  updatedAt: string | null;
};

export type JiraNamedValue = {
  id: string | null;
  name: string;
};

export type JiraAttachmentView = {
  id: string;
  filename: string;
  contentUrl: string | null;
  mimeType: string | null;
  size: number | null;
  author: JiraPerson | null;
  createdAt: string | null;
};

export type JiraIssueLinkView = {
  relationship: string;
  key: string;
  summary: string;
  status: string | null;
};

export type JiraTicketDetail = JiraTicketSummary & {
  jiraUrl: string;
  description: unknown;
  reporter: JiraPerson | null;
  creator: JiraPerson | null;
  labels: string[];
  components: JiraNamedValue[];
  fixVersions: JiraNamedValue[];
  affectedVersions: JiraNamedValue[];
  sprintNames: string[];
  parent: JiraIssueLinkView | null;
  subtasks: JiraIssueLinkView[];
  issueLinks: JiraIssueLinkView[];
  attachments: JiraAttachmentView[];
  comments: JiraCommentView[];
  createdAt: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  timeTracking: unknown;
  cache: JiraCacheMeta;
  commentsCache: JiraCacheMeta;
};

export type JiraMetricWindow = {
  window: "5m" | "10m" | "1h" | "24h";
  total: number;
  live: number;
  cache: number;
  errors: number;
  averageMs: number;
};

export type JiraOperationMetric = {
  operation: string;
  windows: JiraMetricWindow[];
};

export type JiraCacheMetrics = {
  windows: JiraMetricWindow[];
  operations: JiraOperationMetric[];
};

export type JiraApiCallView = {
  id: string;
  operation: string;
  requestSummary: string;
  source: JiraCallSource;
  durationMs: number;
  statusCode: number | null;
  error: string | null;
  itemCount: number | null;
  servedStale: boolean;
  createdAt: string;
};

export type JiraCachedTicketView = {
  issueKey: string;
  projectKey: string;
  summary: string;
  status: string | null;
  coverage: "SUMMARY" | "DETAIL" | "FULL";
  stale: boolean;
  summaryFetchedAt: string | null;
  detailFetchedAt: string | null;
  commentsFetchedAt: string | null;
  updatedAt: string;
};

export type JiraCachedTicketDetail = JiraCachedTicketView & {
  summaryData: unknown;
  detailData: unknown;
  commentsData: unknown;
  cacheEntries: Array<{
    id: string;
    operation: string;
    fetchedAt: string;
  }>;
};

export type PaginatedResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};
