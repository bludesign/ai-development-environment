export type JiraSourceKind = "JQL" | "BOARD";
export type JiraCallSource = "LIVE" | "CACHE" | "ERROR";
export type JiraTextFormat = "ADF" | "MARKDOWN" | "JIRA_WIKI";
export type JiraTicketAssignmentFilter =
  "ALL" | "UNASSIGNED_OR_SELF" | "SELF_IN_PROGRESS";

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
  ticketAssignmentFilter: JiraTicketAssignmentFilter;
  hideCompletedTickets: boolean;
  completedStatusIds: string[];
  branchNamingScript: string;
  sources: JiraSourceView[];
};

export type JiraBranchTicket = {
  ticketKey: string;
  ticketTitle: string;
  ticketType: string | null;
  projectKey: string;
  branchNamingScript: string;
};

export type JiraProjectStatus = {
  id: string;
  name: string;
  category: string;
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
  assigneeAccountId: string | null;
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

export type JiraRichText = {
  format: JiraTextFormat;
  raw: unknown;
  rawText: string;
  markdown: string;
  wikiMarkup: string;
};

export type JiraTextInput = {
  format: Exclude<JiraTextFormat, "ADF">;
  value: string;
};

export type JiraCommentView = {
  id: string;
  author: JiraPerson | null;
  body: unknown;
  content: JiraRichText | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type JiraTicketField = {
  id: string;
  name: string;
  schemaType: string | null;
  custom: boolean;
  value: unknown;
  content: JiraRichText | null;
};

export type JiraEditField = {
  id: string;
  name: string;
  required: boolean;
  schemaType: string | null;
  allowedValues: JiraNamedValue[];
};

export type JiraTransition = {
  id: string;
  name: string;
  toStatusId: string | null;
  toStatus: string;
  toStatusCategory: string | null;
  hasScreen: boolean;
  requiredFields: string[];
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
  descriptionContent: JiraRichText | null;
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
  allFields: JiraTicketField[];
  cache: JiraCacheMeta;
  commentsCache: JiraCacheMeta;
};

export type JiraChangeItem = {
  field: string;
  fieldId: string | null;
  from: string | null;
  to: string | null;
};

export type JiraChange = {
  id: string;
  author: JiraPerson | null;
  createdAt: string | null;
  items: JiraChangeItem[];
};

export type JiraWorklog = {
  id: string;
  author: JiraPerson | null;
  comment: JiraRichText | null;
  timeSpent: string | null;
  timeSpentSeconds: number | null;
  startedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type JiraActivityPage<T> = PaginatedResult<T> & {
  cache: JiraCacheMeta;
};

export type UpdateJiraTicketInput = {
  issueKey: string;
  summary?: string | null;
  description?: JiraTextInput | null;
  priorityId?: string | null;
  labels?: string[] | null;
  componentIds?: string[] | null;
  fixVersionIds?: string[] | null;
  affectedVersionIds?: string[] | null;
  dueDate?: string | null;
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
