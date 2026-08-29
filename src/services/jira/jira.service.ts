import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  createAgileClient,
  createCloudClient,
  type AgileClient,
  type CloudClient,
} from "jira.js";
import { createClient } from "jira.js/core";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  agentEventBus,
  JIRA_TICKET_CHANGED_TOPIC,
} from "@/services/agent-control/event-bus";
import {
  CREDENTIALS,
  CredentialService,
  encodeJsonCredential,
  jiraConnectionSettings,
  readConnectionSettings,
  type JiraConnectionSettings,
} from "@/services/credentials";
import type { WorkflowEventsService } from "@/services/workflows/workflow-events.service";

import type {
  JiraApiCallView,
  JiraAvailableProject,
  JiraCachedTicketDetail,
  JiraCachedTicketView,
  JiraCacheMeta,
  JiraCacheMetrics,
  JiraCallSource,
  JiraChange,
  JiraActivityPage,
  JiraCommentView,
  JiraEditField,
  JiraIssueLinkView,
  JiraMetricWindow,
  JiraNamedValue,
  JiraOperationMetric,
  JiraProjectStatus,
  JiraPerson,
  JiraProjectView,
  JiraSettingsView,
  JiraSourceKind,
  JiraSourceView,
  JiraTicketBoard,
  JiraTicketAssignmentFilter,
  JiraTicketChange,
  JiraTicketDetail,
  JiraTicketSummary,
  JiraBranchTicket,
  JiraTextInput,
  JiraTransition,
  JiraWebhookChangelog,
  JiraWorklog,
  UpdateJiraTicketInput,
  PaginatedResult,
} from "./types";
import {
  DEFAULT_JIRA_BRANCH_NAMING_SCRIPT,
  validateJiraBranchNamingScript,
} from "./branch-naming";
import { jiraTextInputToAdf, normalizeJiraRichText } from "./text-format";

type JsonRecord = Record<string, unknown>;

type CacheResult<T> = {
  value: T;
  source: JiraCallSource;
  stale: boolean;
  fetchedAt: Date;
  entryId: string;
};

type CacheCall<T> = {
  operation: string;
  params: JsonRecord;
  requestSummary: string;
  sourceId?: string | null;
  force?: boolean;
  allowStaleOnError?: boolean;
  fetcher: () => Promise<T>;
  itemCount?: (value: T) => number | null;
};

type RawIssue = JsonRecord & {
  id?: string;
  key?: string;
  fields?: JsonRecord;
};

type RawSearchPage = {
  issues?: RawIssue[];
  isLast?: boolean;
  nextPageToken?: string | null;
  warningMessages?: string[];
  warnings?: unknown[];
};

const SETTINGS_ID = "default";
const DEFAULT_TTL_SECONDS = 300;
const PAGE_SIZE = 100;
const MAX_ISSUES = 1000;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const LIST_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "project",
  "updated",
];

const WINDOW_DEFINITIONS = [
  { window: "5m" as const, milliseconds: 5 * 60 * 1000 },
  { window: "10m" as const, milliseconds: 10 * 60 * 1000 },
  { window: "1h" as const, milliseconds: 60 * 60 * 1000 },
  { window: "24h" as const, milliseconds: 24 * 60 * 60 * 1000 },
];

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}

function searchWarnings(page: RawSearchPage): string[] {
  const structuredWarnings = (page.warnings ?? []).flatMap((value) => {
    const warning = asRecord(value);
    const message = asString(warning.message);
    if (message) return [message];
    const type = asString(warning.type);
    return type ? [type] : [];
  });
  return [...(page.warningMessages ?? []), ...structuredWarnings];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeIssueKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    throw new Error("Invalid Jira issue key");
  }
  return key;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  return asArray(parseJson(value)).flatMap((entry) =>
    typeof entry === "string" && entry.length > 0 ? [entry] : [],
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function normalizeJiraSiteUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") {
    throw new Error("Jira Cloud site URL must use HTTPS");
  }
  if (!url.hostname.toLowerCase().endsWith(".atlassian.net")) {
    throw new Error("Only Jira Cloud *.atlassian.net sites are supported");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Jira site URL must not include credentials, query, or fragment",
    );
  }
  return url.origin;
}

export function parseJiraBoardUrl(value: string, siteUrl: string) {
  const url = new URL(value.trim());
  if (url.origin !== new URL(siteUrl).origin) {
    throw new Error("Board URL must belong to the configured Jira site");
  }
  const pathMatch = url.pathname.match(/\/boards\/(\d+)(?:\/|$)/i);
  const queryValue = url.searchParams.get("rapidView");
  const boardId = Number(pathMatch?.[1] ?? queryValue);
  if (!Number.isSafeInteger(boardId) || boardId <= 0) {
    throw new Error("Board URL must contain a Jira board ID");
  }
  return { boardId, normalizedUrl: url.toString() };
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const status = error.status ?? asRecord(error.response).status;
  return typeof status === "number" ? status : null;
}

function sanitizeError(error: unknown, token?: string | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutToken = token ? raw.replaceAll(token, "[REDACTED]") : raw;
  return withoutToken.slice(0, 1000);
}

function projectKeyForIssue(issue: RawIssue): string {
  const project = asRecord(asRecord(issue.fields).project);
  return asString(project.key) ?? (issue.key?.split("-")[0] || "UNKNOWN");
}

function person(value: unknown): JiraPerson | null {
  const record = asRecord(value);
  const displayName = asString(record.displayName);
  if (!displayName) return null;
  const avatars = asRecord(record.avatarUrls);
  return {
    accountId: asString(record.accountId),
    displayName,
    avatarUrl:
      asString(avatars["48x48"]) ??
      asString(avatars["32x32"]) ??
      asString(avatars["24x24"]),
  };
}

function namedValues(value: unknown): JiraNamedValue[] {
  return asArray(value)
    .map(asRecord)
    .map((entry) => ({
      id: asString(entry.id),
      name: asString(entry.name) ?? "Unknown",
    }));
}

function editableValues(value: unknown): JiraNamedValue[] {
  return asArray(value).flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry, name: entry }];
    const record = asRecord(entry);
    const name =
      asString(record.name) ??
      asString(record.value) ??
      asString(record.displayName) ??
      asString(record.key);
    if (!name) return [];
    return [
      {
        id:
          asString(record.id) ??
          asString(record.accountId) ??
          asString(record.value) ??
          name,
        name,
      },
    ];
  });
}

function issueLink(
  value: unknown,
  relationship: string,
): JiraIssueLinkView | null {
  const issue = asRecord(value);
  const key = asString(issue.key);
  if (!key) return null;
  const fields = asRecord(issue.fields);
  return {
    relationship,
    key,
    summary: asString(fields.summary) ?? key,
    status: asString(asRecord(fields.status).name),
  };
}

function sourceView(source: {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  value: string;
  boardId: number | null;
  position: number;
}): JiraSourceView {
  return {
    ...source,
    kind: source.kind === "BOARD" ? "BOARD" : "JQL",
  };
}

function cacheMeta(result: CacheResult<unknown>): JiraCacheMeta {
  return {
    source: result.source,
    stale: result.stale,
    fetchedAt: result.fetchedAt.toISOString(),
  };
}

function combineCacheMeta(results: CacheResult<unknown>[]): JiraCacheMeta {
  if (results.length === 0) {
    return {
      source: "CACHE",
      stale: false,
      fetchedAt: new Date(0).toISOString(),
    };
  }
  const source = results.some((result) => result.source === "ERROR")
    ? "ERROR"
    : results.some((result) => result.source === "LIVE")
      ? "LIVE"
      : "CACHE";
  return {
    source,
    stale: results.some((result) => result.stale),
    fetchedAt: new Date(
      Math.max(...results.map((result) => result.fetchedAt.getTime())),
    ).toISOString(),
  };
}

function ticketSummary(issue: RawIssue): JiraTicketSummary {
  const fields = asRecord(issue.fields);
  const status = asRecord(fields.status);
  const statusCategory = asRecord(status.statusCategory);
  const assignee = asRecord(fields.assignee);
  const avatars = asRecord(assignee.avatarUrls);
  const project = asRecord(fields.project);
  const key = issue.key ?? "UNKNOWN";
  return {
    id: issue.id ?? key,
    key,
    summary: asString(fields.summary) ?? key,
    statusId: asString(status.id) ?? asString(status.name) ?? "unknown",
    status: asString(status.name) ?? "Unknown",
    statusCategory:
      asString(statusCategory.key) ??
      asString(statusCategory.name) ??
      "unknown",
    issueType: asString(asRecord(fields.issuetype).name),
    priority: asString(asRecord(fields.priority).name),
    assignee: asString(assignee.displayName),
    assigneeAccountId: asString(assignee.accountId),
    assigneeAvatarUrl: asString(avatars["48x48"]) ?? asString(avatars["32x32"]),
    projectKey: asString(project.key) ?? projectKeyForIssue(issue),
    updatedAt: asString(fields.updated),
  };
}

function categoryRank(category: string): number {
  const normalized = category.toLowerCase();
  if (normalized === "new" || normalized.includes("to do")) return 0;
  if (normalized === "indeterminate" || normalized.includes("progress"))
    return 1;
  if (normalized === "done") return 2;
  return 3;
}

const TICKET_ASSIGNMENT_FILTERS = new Set<JiraTicketAssignmentFilter>([
  "ALL",
  "UNASSIGNED_OR_SELF",
  "SELF_IN_PROGRESS",
]);

function ticketAssignmentFilter(value: string): JiraTicketAssignmentFilter {
  return TICKET_ASSIGNMENT_FILTERS.has(value as JiraTicketAssignmentFilter)
    ? (value as JiraTicketAssignmentFilter)
    : "ALL";
}

function isInProgress(category: string): boolean {
  const normalized = category.toLowerCase();
  return normalized === "indeterminate" || normalized.includes("progress");
}

export function filterJiraTicketBoard(
  board: JiraTicketBoard,
  settings: {
    ticketAssignmentFilter: JiraTicketAssignmentFilter;
    hideCompletedTickets: boolean;
    completedStatusIds: string[];
  },
  currentAccountId: string | null,
): JiraTicketBoard {
  const completedStatusIds = settings.hideCompletedTickets
    ? new Set(settings.completedStatusIds)
    : new Set<string>();
  const hiddenStatusNames = new Set(
    board.tickets
      .filter((ticket) => completedStatusIds.has(ticket.statusId))
      .map((ticket) => ticket.status),
  );
  const tickets = board.tickets.filter((ticket) => {
    if (completedStatusIds.has(ticket.statusId)) return false;
    if (settings.ticketAssignmentFilter === "ALL") return true;
    if (settings.ticketAssignmentFilter === "UNASSIGNED_OR_SELF") {
      return (
        ticket.assigneeAccountId === null ||
        ticket.assigneeAccountId === currentAccountId
      );
    }
    return (
      currentAccountId !== null &&
      ticket.assigneeAccountId === currentAccountId &&
      isInProgress(ticket.statusCategory)
    );
  });
  return {
    ...board,
    tickets,
    statusOrder: board.statusOrder.filter(
      (status) => !hiddenStatusNames.has(status),
    ),
  };
}

export class JiraService {
  private readonly inFlight = new Map<string, Promise<CacheResult<unknown>>>();
  private clients:
    { key: string; cloud: CloudClient; agile: AgileClient } | undefined;
  private lastPrunedAt = 0;

  constructor(
    private readonly credentials = new CredentialService(),
    private readonly workflowEvents?: WorkflowEventsService,
    private readonly recordCallLogs = process.env
      .JIRA_CACHE_LOGGING_DISABLED !== "true",
  ) {}

  private async storedConnection() {
    return readConnectionSettings(
      this.credentials,
      CREDENTIALS.jiraConnectionSettings,
      jiraConnectionSettings,
    );
  }

  private async recordTicketWorkflowEvents(
    ticket: JiraTicketDetail,
    changelog?: JiraWebhookChangelog | null,
  ): Promise<void> {
    if (!this.workflowEvents) return;
    const latestComment = ticket.comments.at(-1) ?? null;
    const sessionData = {
      ticket: {
        key: ticket.key,
        title: ticket.summary,
        type: ticket.issueType,
        status: ticket.status,
        statusId: ticket.statusId,
        statusCategory: ticket.statusCategory,
        assignee: ticket.assignee,
        assigneeAccountId: ticket.assigneeAccountId,
        labels: ticket.labels,
        sprintNames: ticket.sprintNames,
        activeSprintNames: ticket.activeSprintNames,
        closedSprintNames: ticket.closedSprintNames,
        url: ticket.jiraUrl,
      },
      comment: latestComment
        ? {
            id: latestComment.id,
            body: latestComment.content?.rawText ?? "",
            author: latestComment.author,
          }
        : null,
      ...(changelog !== undefined ? { changelog } : {}),
    };
    const observedAt = ticket.cache.fetchedAt;
    const currentAccountId = ticket.assigneeAccountId
      ? await this.currentAccountId().catch(() => null)
      : null;
    let observations: Array<readonly [string, unknown]> = [
      ["JIRA_STATUS", ticket.statusId],
      ["JIRA_LABEL", JSON.stringify([...ticket.labels].sort())],
      ["JIRA_MENTION", latestComment?.id ?? "none"],
      ["JIRA_SPRINT_STARTED", [...ticket.activeSprintNames].sort()],
      ["JIRA_TICKET_UPDATED", ticket.updatedAt ?? "unknown"],
      ["JIRA_COMMENT_ADDED", latestComment?.id ?? "none"],
      ["JIRA_SPRINT_ENDED", [...ticket.closedSprintNames].sort()],
    ];
    if (currentAccountId && currentAccountId === ticket.assigneeAccountId) {
      observations.push(["JIRA_ASSIGNED_SELF", currentAccountId]);
    }
    if (changelog?.items.length) {
      const changedFields = new Set(
        changelog.items.flatMap((item) =>
          [item.fieldId, item.field]
            .filter((value): value is string => Boolean(value))
            .map((value) => value.trim().toLowerCase()),
        ),
      );
      const relevantKinds = new Set(["JIRA_TICKET_UPDATED"]);
      if (changedFields.has("status")) relevantKinds.add("JIRA_STATUS");
      if (changedFields.has("label") || changedFields.has("labels")) {
        relevantKinds.add("JIRA_LABEL");
      }
      if (changedFields.has("assignee")) {
        relevantKinds.add("JIRA_ASSIGNED_SELF");
      }
      if (changedFields.has("sprint")) {
        relevantKinds.add("JIRA_SPRINT_STARTED");
        relevantKinds.add("JIRA_SPRINT_ENDED");
      }
      observations = observations.filter(([kind]) => relevantKinds.has(kind));
    }
    await Promise.allSettled(
      observations.map(([kind, cursorValue]) =>
        this.workflowEvents!.record({
          kind,
          subjectKey: ticket.key,
          dedupeKey: `jira-trigger:${kind}:${ticket.key}:${observedAt}`,
          payload: { ...sessionData, sessionData, cursorValue },
        }),
      ),
    );
  }

  async getSettings(): Promise<JiraSettingsView> {
    const prisma = await getPrismaClient();
    const [settings, connection, tokenConfigured] = await Promise.all([
      prisma.jiraSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, cacheTtlSeconds: DEFAULT_TTL_SECONDS },
        update: {},
      }),
      this.storedConnection(),
      this.credentials.isConfigured(CREDENTIALS.jiraApiToken),
    ]);
    return {
      siteUrl: connection?.value.siteUrl ?? null,
      email: connection?.value.email ?? null,
      tokenConfigured: Boolean(connection && tokenConfigured),
      cacheTtlSeconds: settings.cacheTtlSeconds,
      updatedAt: new Date(
        Math.max(
          settings.updatedAt.getTime(),
          connection?.updatedAt.getTime() ?? 0,
        ),
      ).toISOString(),
    };
  }

  async saveSettings(input: {
    siteUrl: string;
    email: string;
    apiToken?: string | null;
    resetSite?: boolean;
  }): Promise<JiraSettingsView> {
    const prisma = await getPrismaClient();
    const siteUrl = normalizeJiraSiteUrl(input.siteUrl);
    const email = input.email.trim();
    if (!/^\S+@\S+\.\S+$/.test(email))
      throw new Error("A valid Jira email is required");
    const existing = await this.storedConnection();
    const nextToken = input.apiToken?.trim() || null;
    const siteChanged = Boolean(
      existing?.value.siteUrl && existing.value.siteUrl !== siteUrl,
    );
    if (siteChanged && !input.resetSite) {
      throw new Error("Changing the Jira site requires resetSite=true");
    }
    const credentialsChanged =
      existing?.value.siteUrl !== siteUrl ||
      existing?.value.email !== email ||
      Boolean(nextToken);

    const nextConnection: JiraConnectionSettings = { siteUrl, email };

    const saveMetadata = async (transaction: Prisma.TransactionClient) => {
      if (siteChanged) {
        await transaction.jiraProject.deleteMany();
        await transaction.jiraWebhookDelivery.deleteMany();
      }
      if (credentialsChanged) {
        await transaction.jiraCacheEntry.deleteMany();
        await transaction.jiraCachedTicket.deleteMany();
      }
      await transaction.jiraSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          cacheTtlSeconds: DEFAULT_TTL_SECONDS,
        },
        update: siteChanged
          ? {
              webhookEnabled: false,
              webhookConfiguredAt: null,
              webhookId: null,
            }
          : {},
      });
    };
    const entries = [
      ...(!existing ||
      JSON.stringify(existing.value) !== JSON.stringify(nextConnection)
        ? [
            {
              descriptor: CREDENTIALS.jiraConnectionSettings,
              value: encodeJsonCredential(nextConnection),
            },
          ]
        : []),
      ...(nextToken
        ? [
            {
              descriptor: CREDENTIALS.jiraApiToken,
              value: Buffer.from(nextToken, "utf8"),
            },
          ]
        : []),
    ];
    if (entries.length) {
      if (siteChanged) {
        // The webhook secret is registered against the old site's Jira instance, so it
        // must roll back with the new connection and site-scoped Prisma cleanup.
        await this.credentials.setAndDeleteMany(
          entries,
          [CREDENTIALS.jiraWebhookSecret, CREDENTIALS.jiraWebhookSettings],
          saveMetadata,
        );
      } else {
        await this.credentials.setMany(entries, saveMetadata);
      }
    } else {
      await prisma.$transaction(saveMetadata);
    }
    this.clients = undefined;
    return this.getSettings();
  }

  async clearCredentials(): Promise<JiraSettingsView> {
    const prisma = await getPrismaClient();
    const [settings, connection] = await Promise.all([
      prisma.jiraSettings.findUnique({
        where: { id: SETTINGS_ID },
        select: {
          webhookId: true,
        },
      }),
      this.storedConnection(),
    ]);
    const tokenConfigured = await this.credentials.isConfigured(
      CREDENTIALS.jiraApiToken,
    );
    if (
      connection?.value.siteUrl &&
      connection.value.email &&
      settings?.webhookId &&
      tokenConfigured
    ) {
      try {
        await this.webhookApiRequest(
          "DELETE",
          `/rest/webhooks/1.0/webhook/${encodeURIComponent(settings.webhookId)}`,
        );
      } catch (error) {
        if (errorStatus(error) !== 404) throw error;
      }
    }
    await this.credentials.deleteMany(
      [
        CREDENTIALS.jiraConnectionSettings,
        CREDENTIALS.jiraApiToken,
        CREDENTIALS.jiraWebhookSettings,
        CREDENTIALS.jiraWebhookSecret,
      ],
      async (transaction) => {
        await transaction.jiraCacheEntry.deleteMany();
        await transaction.jiraCachedTicket.deleteMany();
        await transaction.jiraWebhookDelivery.deleteMany();
        await transaction.jiraSettings.upsert({
          where: { id: SETTINGS_ID },
          create: { id: SETTINGS_ID, cacheTtlSeconds: DEFAULT_TTL_SECONDS },
          update: {
            webhookEnabled: false,
            webhookConfiguredAt: null,
            webhookId: null,
          },
        });
      },
    );
    this.clients = undefined;
    return this.getSettings();
  }

  async updateCacheTtl(ttlMinutes: number): Promise<JiraSettingsView> {
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
      throw new Error("Cache TTL must be an integer from 1 to 1440 minutes");
    }
    const prisma = await getPrismaClient();
    await prisma.jiraSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        cacheTtlSeconds: ttlMinutes * 60,
      },
      update: { cacheTtlSeconds: ttlMinutes * 60 },
    });
    return this.getSettings();
  }

  async testConnection() {
    const result = await this.cachedCall({
      operation: "MYSELF",
      params: {},
      requestSummary: "Current Jira user",
      force: true,
      allowStaleOnError: false,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.myself.getCurrentUser();
      },
    });
    if (result.stale) {
      throw new Error(
        "Jira connection test failed because the live request failed",
      );
    }
    const user = asRecord(result.value);
    return {
      accountId: asString(user.accountId),
      displayName: asString(user.displayName) ?? "Jira user",
      emailAddress: asString(user.emailAddress),
      cache: cacheMeta(result),
    };
  }

  async listProjects(): Promise<JiraProjectView[]> {
    const prisma = await getPrismaClient();
    const projects = await prisma.jiraProject.findMany({
      include: {
        sources: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return projects.map((project) => ({
      id: project.id,
      jiraId: project.jiraId,
      key: project.key,
      name: project.name,
      avatarUrl: project.avatarUrl,
      position: project.position,
      ticketAssignmentFilter: ticketAssignmentFilter(
        project.ticketAssignmentFilter,
      ),
      hideCompletedTickets: project.hideCompletedTickets,
      completedStatusIds: parseStringArray(project.completedStatusIdsJson),
      doneStatusId: project.doneStatusId,
      branchNamingScript:
        project.branchNamingScript ?? DEFAULT_JIRA_BRANCH_NAMING_SCRIPT,
      sources: project.sources.map(sourceView),
    }));
  }

  async projectStatuses(projectId: string): Promise<JiraProjectStatus[]> {
    const prisma = await getPrismaClient();
    const project = await prisma.jiraProject.findUnique({
      where: { id: projectId },
      select: { jiraId: true, key: true },
    });
    if (!project) throw new Error("Jira project not found");
    const result = await this.cachedCall({
      operation: "PROJECT_STATUSES",
      params: { jiraId: project.jiraId },
      requestSummary: `Statuses for project ${project.key}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.projects.getAllStatuses({
          projectIdOrKey: project.jiraId,
        });
      },
    });
    const statuses = new Map<string, JiraProjectStatus>();
    for (const issueType of asArray(result.value).map(asRecord)) {
      for (const rawStatus of asArray(issueType.statuses).map(asRecord)) {
        const id = asString(rawStatus.id);
        const name = asString(rawStatus.name);
        if (!id || !name || statuses.has(id)) continue;
        const category = asRecord(rawStatus.statusCategory);
        statuses.set(id, {
          id,
          name,
          category:
            asString(category.key) ?? asString(category.name) ?? "unknown",
        });
      }
    }
    return [...statuses.values()].sort(
      (first, second) =>
        categoryRank(first.category) - categoryRank(second.category) ||
        first.name.localeCompare(second.name),
    );
  }

  async updateProjectDisplaySettings(input: {
    projectId: string;
    ticketAssignmentFilter: JiraTicketAssignmentFilter;
    hideCompletedTickets: boolean;
    completedStatusIds: string[];
    doneStatusId?: string | null;
  }): Promise<JiraProjectView[]> {
    if (!TICKET_ASSIGNMENT_FILTERS.has(input.ticketAssignmentFilter)) {
      throw new Error("Invalid Jira ticket assignment filter");
    }
    const completedStatusIds = [
      ...new Set(
        input.completedStatusIds
          .map((statusId) => statusId.trim())
          .filter(Boolean),
      ),
    ].slice(0, 200);
    const prisma = await getPrismaClient();
    const doneStatusId =
      input.doneStatusId === undefined
        ? undefined
        : input.doneStatusId?.trim() || null;
    if (doneStatusId) {
      const available = await this.projectStatuses(input.projectId);
      if (!available.some((status) => status.id === doneStatusId)) {
        throw new Error("The selected Jira done status is not available");
      }
    }
    await prisma.jiraProject.update({
      where: { id: input.projectId },
      data: {
        ticketAssignmentFilter: input.ticketAssignmentFilter,
        hideCompletedTickets: input.hideCompletedTickets,
        completedStatusIdsJson: JSON.stringify(completedStatusIds),
        ...(doneStatusId === undefined ? {} : { doneStatusId }),
      },
    });
    return this.listProjects();
  }

  async updateProjectBranchNaming(
    projectId: string,
    branchNamingScript: string,
  ): Promise<JiraProjectView[]> {
    const prisma = await getPrismaClient();
    const project = await prisma.jiraProject.findUnique({
      where: { id: projectId },
      select: { key: true },
    });
    if (!project) throw new Error("Jira project not found");
    const validated = await validateJiraBranchNamingScript(
      branchNamingScript,
      project.key,
    );
    await prisma.jiraProject.update({
      where: { id: projectId },
      data: { branchNamingScript: validated },
    });
    return this.listProjects();
  }

  async availableProjects(): Promise<JiraAvailableProject[]> {
    const projects: JiraAvailableProject[] = [];
    let startAt = 0;
    while (true) {
      const result = await this.cachedCall({
        operation: "PROJECTS",
        params: { startAt, maxResults: PAGE_SIZE },
        requestSummary: `Visible projects from ${startAt}`,
        fetcher: async () => {
          const { cloud } = await this.getClients();
          return cloud.projects.searchProjects({
            startAt,
            maxResults: PAGE_SIZE,
            orderBy: "name",
          });
        },
        itemCount: (value) => asArray(asRecord(value).values).length,
      });
      const page = asRecord(result.value);
      const values = asArray(page.values).map(asRecord);
      projects.push(
        ...values.flatMap((project) => {
          const jiraId = asString(project.id);
          const key = asString(project.key);
          const name = asString(project.name);
          if (!jiraId || !key || !name) return [];
          const avatars = asRecord(project.avatarUrls);
          return [
            {
              jiraId,
              key,
              name,
              avatarUrl:
                asString(avatars["48x48"]) ?? asString(avatars["32x32"]),
            },
          ];
        }),
      );
      const total = asNumber(page.total) ?? projects.length;
      if (values.length === 0 || projects.length >= total) break;
      startAt += values.length;
    }
    return projects;
  }

  async addProject(jiraId: string): Promise<JiraProjectView[]> {
    const id = jiraId.trim();
    if (!id) throw new Error("Jira project ID is required");
    const result = await this.cachedCall({
      operation: "PROJECT",
      params: { jiraId: id },
      requestSummary: `Project ${id}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.projects.getProject({ projectIdOrKey: id });
      },
    });
    const project = asRecord(result.value);
    const key = asString(project.key);
    const name = asString(project.name);
    const resolvedId = asString(project.id);
    if (!key || !name || !resolvedId)
      throw new Error("Jira returned an incomplete project");
    const avatars = asRecord(project.avatarUrls);
    const prisma = await getPrismaClient();
    const aggregate = await prisma.jiraProject.aggregate({
      _max: { position: true },
    });
    await prisma.jiraProject.create({
      data: {
        id: randomUUID(),
        jiraId: resolvedId,
        key,
        name,
        avatarUrl: asString(avatars["48x48"]) ?? asString(avatars["32x32"]),
        position: (aggregate._max.position ?? -1) + 1,
        branchNamingScript: DEFAULT_JIRA_BRANCH_NAMING_SCRIPT,
      },
    });
    return this.listProjects();
  }

  async removeProject(projectId: string): Promise<JiraProjectView[]> {
    const prisma = await getPrismaClient();
    const sources = await prisma.jiraSource.findMany({
      where: { projectId },
      select: { id: true },
    });
    const sourceIds = sources.map((source) => source.id);
    await prisma.$transaction(async (transaction) => {
      if (sourceIds.length > 0) {
        await transaction.jiraCacheEntry.deleteMany({
          where: { sourceId: { in: sourceIds } },
        });
      }
      await transaction.jiraProject.delete({ where: { id: projectId } });
      await transaction.jiraCachedTicket.deleteMany({
        where: { cacheEntries: { none: {} } },
      });
    });
    return this.listProjects();
  }

  async createSource(input: {
    projectId: string;
    name: string;
    kind: JiraSourceKind;
    value: string;
  }): Promise<JiraProjectView[]> {
    const validated = await this.validateSource(input.kind, input.value);
    const name = this.validateSourceName(input.name);
    const prisma = await getPrismaClient();
    const project = await prisma.jiraProject.findUnique({
      where: { id: input.projectId },
    });
    if (!project) throw new Error("Jira project not found");
    const aggregate = await prisma.jiraSource.aggregate({
      where: { projectId: input.projectId },
      _max: { position: true },
    });
    await prisma.jiraSource.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        name,
        kind: input.kind,
        value: validated.value,
        boardId: validated.boardId,
        position: (aggregate._max.position ?? -1) + 1,
      },
    });
    return this.listProjects();
  }

  async updateSource(input: {
    id: string;
    name: string;
    kind: JiraSourceKind;
    value: string;
  }): Promise<JiraProjectView[]> {
    const validated = await this.validateSource(input.kind, input.value);
    const name = this.validateSourceName(input.name);
    const prisma = await getPrismaClient();
    await prisma.$transaction([
      prisma.jiraCacheEntry.deleteMany({ where: { sourceId: input.id } }),
      prisma.jiraSource.update({
        where: { id: input.id },
        data: {
          name,
          kind: input.kind,
          value: validated.value,
          boardId: validated.boardId,
        },
      }),
    ]);
    return this.listProjects();
  }

  async deleteSource(id: string): Promise<JiraProjectView[]> {
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      await transaction.jiraCacheEntry.deleteMany({ where: { sourceId: id } });
      await transaction.jiraSource.delete({ where: { id } });
      await transaction.jiraCachedTicket.deleteMany({
        where: { cacheEntries: { none: {} } },
      });
    });
    return this.listProjects();
  }

  async ticketBoard(sourceId: string, force = false): Promise<JiraTicketBoard> {
    const prisma = await getPrismaClient();
    const source = await prisma.jiraSource.findUnique({
      where: { id: sourceId },
      include: { project: true },
    });
    if (!source) throw new Error("Jira source not found");
    const previous = await prisma.jiraCacheEntry.findFirst({
      where: { sourceId, issues: { some: {} } },
      orderBy: { fetchedAt: "desc" },
      include: { issues: { select: { issueKey: true } } },
    });
    const previousKeys = new Set(
      previous?.issues.map(({ issueKey }) => issueKey) ?? [],
    );
    const loaded =
      source.kind === "BOARD"
        ? await this.loadBoardSource(sourceView(source), force)
        : await this.loadJqlSource(sourceView(source), force);
    const settings = {
      ticketAssignmentFilter: ticketAssignmentFilter(
        source.project.ticketAssignmentFilter,
      ),
      hideCompletedTickets: source.project.hideCompletedTickets,
      completedStatusIds: parseStringArray(
        source.project.completedStatusIdsJson,
      ),
    };
    const currentAccountId =
      settings.ticketAssignmentFilter === "ALL"
        ? null
        : await this.currentAccountId();
    const board = filterJiraTicketBoard(
      { source: sourceView(source), ...loaded },
      settings,
      currentAccountId,
    );
    if (this.workflowEvents && previous) {
      await Promise.allSettled(
        board.tickets
          .filter(({ key }) => !previousKeys.has(key))
          .map((ticket) => {
            const sessionData = {
              ticket: {
                key: ticket.key,
                title: ticket.summary,
                type: ticket.issueType,
                status: ticket.status,
                statusId: ticket.statusId,
                statusCategory: ticket.statusCategory,
                assignee: ticket.assignee,
              },
            };
            return this.workflowEvents!.record({
              kind: "JIRA_SOURCE_NEW_TICKET",
              subjectKey: `${sourceId}:${ticket.key}`,
              dedupeKey: `jira-source-new:${sourceId}:${ticket.key}:${board.cache.fetchedAt}`,
              payload: {
                ...sessionData,
                sessionData,
                source: { id: sourceId, name: source.name, kind: source.kind },
                cursorValue: ticket.key,
              },
            });
          }),
      );
    }
    return board;
  }

  async ticket(
    issueKey: string,
    force = false,
    changelog?: JiraWebhookChangelog | null,
  ): Promise<JiraTicketDetail> {
    const key = normalizeIssueKey(issueKey);
    const detail = await this.cachedCall<RawIssue>({
      operation: "ISSUE",
      params: { issueKey: key, fields: "*all", expand: "names,schema" },
      requestSummary: `Issue ${key} with all fields`,
      force,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issues.getIssue({
          issueIdOrKey: key,
          fields: ["*all"],
          expand: ["names", "schema"],
          updateHistory: false,
        });
      },
    });
    if (detail.source === "LIVE")
      await this.storeDetail(detail.entryId, detail.value, detail.fetchedAt);

    const commentResults: CacheResult<unknown>[] = [];
    const comments: unknown[] = [];
    let startAt = 0;
    while (true) {
      const result = await this.cachedCall({
        operation: "COMMENTS",
        params: { issueKey: key, startAt, maxResults: PAGE_SIZE },
        requestSummary: `Comments for ${key} from ${startAt}`,
        force,
        fetcher: async () => {
          const { cloud } = await this.getClients();
          return cloud.issueComments.getComments({
            issueIdOrKey: key,
            startAt,
            maxResults: PAGE_SIZE,
            orderBy: "created",
          });
        },
        itemCount: (value) => asArray(asRecord(value).comments).length,
      });
      commentResults.push(result);
      const page = asRecord(result.value);
      const values = asArray(page.comments);
      comments.push(...values);
      const total = asNumber(page.total) ?? comments.length;
      if (values.length === 0 || comments.length >= total) break;
      startAt += values.length;
    }
    const commentsFetchedAt = new Date(
      Math.min(...commentResults.map((result) => result.fetchedAt.getTime())),
    );
    await this.storeComments(
      key,
      comments,
      commentsFetchedAt,
      commentResults.map((result) => result.entryId),
    );
    const settings = await this.requireCredentials();
    const ticket = this.normalizeTicketDetail(
      detail.value,
      comments,
      settings.siteUrl,
      cacheMeta(detail),
      combineCacheMeta(commentResults),
    );
    await this.recordTicketWorkflowEvents(ticket, changelog);
    return ticket;
  }

  async assignableUsers(issueKey: string, query = ""): Promise<JiraPerson[]> {
    const key = normalizeIssueKey(issueKey);
    const normalizedQuery = query.trim().slice(0, 100);
    const result = await this.cachedCall({
      operation: "ASSIGNABLE_USERS",
      params: { issueKey: key, query: normalizedQuery, maxResults: 50 },
      requestSummary: `Assignable users for ${key}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.userSearch.findAssignableUsers({
          issueKey: key,
          query: normalizedQuery,
          maxResults: 50,
          recommend: true,
        });
      },
      itemCount: (value) => asArray(value).length,
    });
    await this.linkCacheEntryToIssue(key, result.entryId);
    return asArray(result.value)
      .map(person)
      .filter((value): value is JiraPerson => value !== null);
  }

  async ticketTransitions(issueKey: string): Promise<JiraTransition[]> {
    const key = normalizeIssueKey(issueKey);
    const result = await this.cachedCall({
      operation: "ISSUE_TRANSITIONS",
      params: { issueKey: key, expand: "transitions.fields" },
      requestSummary: `Available transitions for ${key}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issues.getTransitions({
          issueIdOrKey: key,
          expand: "transitions.fields",
        });
      },
      itemCount: (value) => asArray(asRecord(value).transitions).length,
    });
    await this.linkCacheEntryToIssue(key, result.entryId);
    return asArray(asRecord(result.value).transitions)
      .map(asRecord)
      .filter((transition) => transition.isAvailable !== false)
      .flatMap((transition) => {
        const id = asString(transition.id);
        const name = asString(transition.name);
        if (!id || !name) return [];
        const destination = asRecord(transition.to);
        const category = asRecord(destination.statusCategory);
        const requiredFields = Object.entries(asRecord(transition.fields))
          .filter(([, rawField]) => asBoolean(asRecord(rawField).required))
          .map(
            ([fieldId, rawField]) =>
              asString(asRecord(rawField).name) ?? fieldId,
          );
        return [
          {
            id,
            name,
            toStatusId: asString(destination.id),
            toStatus: asString(destination.name) ?? name,
            toStatusCategory: asString(category.key) ?? asString(category.name),
            hasScreen: asBoolean(transition.hasScreen),
            requiredFields,
          },
        ];
      });
  }

  async ticketEditFields(issueKey: string): Promise<JiraEditField[]> {
    const key = normalizeIssueKey(issueKey);
    const result = await this.cachedCall({
      operation: "ISSUE_EDIT_META",
      params: { issueKey: key },
      requestSummary: `Editable fields for ${key}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issues.getEditIssueMeta({ issueIdOrKey: key });
      },
      itemCount: (value) =>
        Object.keys(asRecord(asRecord(value).fields)).length,
    });
    await this.linkCacheEntryToIssue(key, result.entryId);
    return Object.entries(asRecord(asRecord(result.value).fields))
      .map(([id, rawValue]) => {
        const field = asRecord(rawValue);
        return {
          id,
          name: asString(field.name) ?? id,
          required: asBoolean(field.required),
          schemaType: asString(asRecord(field.schema).type),
          allowedValues: editableValues(field.allowedValues),
        };
      })
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  async ticketChanges(
    issueKey: string,
    limit = 50,
    offset = 0,
  ): Promise<JiraActivityPage<JiraChange>> {
    const key = normalizeIssueKey(issueKey);
    const pagination = this.validatePagination(limit, offset);
    const probe = await this.cachedCall({
      operation: "ISSUE_CHANGELOG",
      params: { issueKey: key, startAt: 0, maxResults: 1 },
      requestSummary: `Changelog count for ${key}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issues.getChangeLogs({
          issueIdOrKey: key,
          startAt: 0,
          maxResults: 1,
        });
      },
      itemCount: (value) => asArray(asRecord(value).values).length,
    });
    await this.linkCacheEntryToIssue(key, probe.entryId);
    const total = asNumber(asRecord(probe.value).total) ?? 0;
    const count = Math.min(
      pagination.limit,
      Math.max(0, total - pagination.offset),
    );
    const startAt = Math.max(0, total - pagination.offset - count);
    if (count === 0) {
      return { ...pagination, total, items: [], cache: cacheMeta(probe) };
    }
    const page = await this.cachedCall({
      operation: "ISSUE_CHANGELOG",
      params: { issueKey: key, startAt, maxResults: count },
      requestSummary: `Changelog for ${key} from ${startAt}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issues.getChangeLogs({
          issueIdOrKey: key,
          startAt,
          maxResults: count,
        });
      },
      itemCount: (value) => asArray(asRecord(value).values).length,
    });
    await this.linkCacheEntryToIssue(key, page.entryId);
    const items = asArray(asRecord(page.value).values)
      .map(asRecord)
      .reverse()
      .map((change) => ({
        id: asString(change.id) ?? randomUUID(),
        author: person(change.author),
        createdAt: asString(change.created),
        items: asArray(change.items)
          .map(asRecord)
          .map((item) => ({
            field: asString(item.field) ?? "Field",
            fieldId: asString(item.fieldId),
            from: asString(item.fromString) ?? asString(item.from),
            to: asString(item.toString) ?? asString(item.to),
          })),
      }));
    return {
      ...pagination,
      total,
      items,
      cache: combineCacheMeta([probe, page]),
    };
  }

  async ticketWorklogs(
    issueKey: string,
    limit = 50,
    offset = 0,
  ): Promise<JiraActivityPage<JiraWorklog>> {
    const key = normalizeIssueKey(issueKey);
    const pagination = this.validatePagination(limit, offset);
    const probe = await this.cachedCall({
      operation: "ISSUE_WORKLOGS",
      params: { issueKey: key, startAt: 0, maxResults: 1 },
      requestSummary: `Worklog count for ${key}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issueWorklogs.getIssueWorklog({
          issueIdOrKey: key,
          startAt: 0,
          maxResults: 1,
        });
      },
      itemCount: (value) => asArray(asRecord(value).worklogs).length,
    });
    await this.linkCacheEntryToIssue(key, probe.entryId);
    const total = asNumber(asRecord(probe.value).total) ?? 0;
    const count = Math.min(
      pagination.limit,
      Math.max(0, total - pagination.offset),
    );
    const startAt = Math.max(0, total - pagination.offset - count);
    if (count === 0) {
      return { ...pagination, total, items: [], cache: cacheMeta(probe) };
    }
    const page = await this.cachedCall({
      operation: "ISSUE_WORKLOGS",
      params: { issueKey: key, startAt, maxResults: count },
      requestSummary: `Worklogs for ${key} from ${startAt}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issueWorklogs.getIssueWorklog({
          issueIdOrKey: key,
          startAt,
          maxResults: count,
        });
      },
      itemCount: (value) => asArray(asRecord(value).worklogs).length,
    });
    await this.linkCacheEntryToIssue(key, page.entryId);
    const settings = await this.requireCredentials();
    const items = asArray(asRecord(page.value).worklogs)
      .map(asRecord)
      .reverse()
      .map((worklog) => ({
        id: asString(worklog.id) ?? randomUUID(),
        author: person(worklog.author),
        comment: normalizeJiraRichText(
          worklog.comment ?? null,
          settings.siteUrl,
        ),
        timeSpent: asString(worklog.timeSpent),
        timeSpentSeconds: asNumber(worklog.timeSpentSeconds),
        startedAt: asString(worklog.started),
        createdAt: asString(worklog.created),
        updatedAt: asString(worklog.updated),
      }));
    const latest = items[0];
    if (this.workflowEvents && latest) {
      const sessionData = {
        ticket: { key },
        worklog: {
          id: latest.id,
          author: latest.author,
          timeSpent: latest.timeSpent,
          timeSpentSeconds: latest.timeSpentSeconds,
          startedAt: latest.startedAt,
          updatedAt: latest.updatedAt,
        },
      };
      await this.workflowEvents.record({
        kind: "JIRA_WORKLOG_ADDED",
        subjectKey: key,
        dedupeKey: `jira-worklog:${key}:${latest.id}:${page.fetchedAt}`,
        payload: {
          ...sessionData,
          sessionData,
          cursorValue: latest.id,
        },
      });
    }
    return {
      ...pagination,
      total,
      items,
      cache: combineCacheMeta([probe, page]),
    };
  }

  async addComment(
    issueKey: string,
    content: JiraTextInput,
  ): Promise<JiraTicketDetail> {
    const key = normalizeIssueKey(issueKey);
    if (!content.value.trim()) throw new Error("Comment text is required");
    const document = jiraTextInputToAdf(content);
    return this.mutateTicket(key, "ADD_COMMENT", async () => {
      const { cloud } = await this.getClients();
      await cloud.issueComments.addComment({
        issueIdOrKey: key,
        body: document as never,
      });
    });
  }

  async assignTicket(
    issueKey: string,
    accountId: string | null,
  ): Promise<JiraTicketDetail> {
    const key = normalizeIssueKey(issueKey);
    const normalizedAccountId = accountId?.trim() || null;
    return this.mutateTicket(key, "ASSIGN_ISSUE", async () => {
      const { cloud } = await this.getClients();
      await cloud.issues.assignIssue({
        issueIdOrKey: key,
        // Jira documents null as the value for unassigning an issue, but the
        // jira.js 6.1 generated input type currently only permits strings.
        accountId: normalizedAccountId as never,
      });
    });
  }

  async transitionTicket(
    issueKey: string,
    transitionId: string,
  ): Promise<JiraTicketDetail> {
    const key = normalizeIssueKey(issueKey);
    const transition = (await this.ticketTransitions(key)).find(
      (item) => item.id === transitionId,
    );
    if (!transition) throw new Error("The Jira transition is not available");
    if (transition.requiredFields.length > 0) {
      throw new Error(
        `This transition requires fields that must be completed in Jira: ${transition.requiredFields.join(", ")}`,
      );
    }
    return this.mutateTicket(key, "TRANSITION_ISSUE", async () => {
      const { cloud } = await this.getClients();
      await cloud.issues.doTransition({
        issueIdOrKey: key,
        transition: { id: transition.id },
      });
    });
  }

  async transitionTicketToConfiguredDone(
    issueKey: string,
  ): Promise<JiraTicketDetail> {
    const key = normalizeIssueKey(issueKey);
    const projectKey = key.split("-")[0] ?? "";
    const prisma = await getPrismaClient();
    const project = await prisma.jiraProject.findUnique({
      where: { key: projectKey },
      select: { doneStatusId: true },
    });
    if (!project?.doneStatusId) {
      throw new Error(
        `Configure a done status for Jira project ${projectKey} before using this option`,
      );
    }
    const ticket = await this.ticket(key);
    if (ticket.statusId === project.doneStatusId) return ticket;
    const transition = (await this.ticketTransitions(key))
      .filter((item) => item.toStatusId === project.doneStatusId)
      .sort(
        (first, second) =>
          first.requiredFields.length - second.requiredFields.length,
      )[0];
    if (!transition) {
      throw new Error(
        "Jira does not currently offer a transition to the configured done status",
      );
    }
    return this.transitionTicket(key, transition.id);
  }

  async updateTicket(input: UpdateJiraTicketInput): Promise<JiraTicketDetail> {
    const key = normalizeIssueKey(input.issueKey);
    const editFields = new Map(
      (await this.ticketEditFields(key)).map((field) => [field.id, field]),
    );
    const fields: JsonRecord = {};
    const requested = (fieldId: string) => {
      const field = editFields.get(fieldId);
      if (!field) throw new Error(`${fieldId} is not editable on this ticket`);
      return field;
    };
    const has = (name: keyof UpdateJiraTicketInput) =>
      Object.prototype.hasOwnProperty.call(input, name);

    if (has("summary")) {
      requested("summary");
      const summary = input.summary?.trim();
      if (!summary) throw new Error("Ticket summary is required");
      fields.summary = summary;
    }
    if (has("description")) {
      const field = requested("description");
      if (input.description === null) {
        if (field.required) throw new Error("Description is required");
        fields.description = null;
      } else if (input.description) {
        fields.description = jiraTextInputToAdf(input.description);
      }
    }
    if (has("priorityId")) {
      const field = requested("priority");
      const priorityId = input.priorityId?.trim() || null;
      if (!priorityId && field.required)
        throw new Error("Priority is required");
      if (
        priorityId &&
        field.allowedValues.length > 0 &&
        !field.allowedValues.some((value) => value.id === priorityId)
      ) {
        throw new Error("The selected priority is not available");
      }
      fields.priority = priorityId ? { id: priorityId } : null;
    }
    if (has("labels")) {
      requested("labels");
      fields.labels = [
        ...new Set(
          (input.labels ?? []).map((label) => label.trim()).filter(Boolean),
        ),
      ];
    }
    const setIds = (
      inputName: "componentIds" | "fixVersionIds" | "affectedVersionIds",
      fieldId: "components" | "fixVersions" | "versions",
    ) => {
      if (!has(inputName)) return;
      const field = requested(fieldId);
      const ids = [...new Set(input[inputName] ?? [])];
      if (
        field.allowedValues.length > 0 &&
        ids.some((id) => !field.allowedValues.some((value) => value.id === id))
      ) {
        throw new Error(`A selected ${field.name} value is not available`);
      }
      fields[fieldId] = ids.map((id) => ({ id }));
    };
    setIds("componentIds", "components");
    setIds("fixVersionIds", "fixVersions");
    setIds("affectedVersionIds", "versions");
    if (has("dueDate")) {
      const field = requested("duedate");
      const dueDate = input.dueDate?.trim() || null;
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        throw new Error("Due date must use YYYY-MM-DD");
      }
      if (!dueDate && field.required) throw new Error("Due date is required");
      fields.duedate = dueDate;
    }
    if (Object.keys(fields).length === 0) {
      throw new Error("At least one editable Jira field is required");
    }
    return this.mutateTicket(key, "EDIT_ISSUE", async () => {
      const { cloud } = await this.getClients();
      await cloud.issues.editIssue({
        issueIdOrKey: key,
        fields,
      });
    });
  }

  async createTicket(input: {
    projectKey: string;
    issueTypeId: string;
    summary: string;
    description?: JiraTextInput | null;
    fields?: Record<string, unknown> | null;
  }): Promise<JiraTicketDetail> {
    const projectKey = input.projectKey.trim().toUpperCase();
    const issueTypeId = input.issueTypeId.trim();
    const summary = input.summary.trim();
    if (!projectKey || !issueTypeId || !summary) {
      throw new Error("Project, issue type, and summary are required");
    }
    const { cloud } = await this.getClients();
    const created = await cloud.issues.createIssue({
      fields: {
        ...(input.fields ?? {}),
        project: { key: projectKey },
        issuetype: { id: issueTypeId },
        summary,
        ...(input.description
          ? { description: jiraTextInputToAdf(input.description) }
          : {}),
      },
    });
    if (!created.key)
      throw new Error("Jira did not return the created issue key");
    return this.ticket(created.key, true);
  }

  async addWorklog(input: {
    issueKey: string;
    timeSpentSeconds: number;
    startedAt?: string | null;
    comment?: JiraTextInput | null;
  }): Promise<JiraTicketDetail> {
    const key = normalizeIssueKey(input.issueKey);
    if (
      !Number.isInteger(input.timeSpentSeconds) ||
      input.timeSpentSeconds < 1
    ) {
      throw new Error("Time spent must be a positive number of seconds");
    }
    const { cloud } = await this.getClients();
    await cloud.issueWorklogs.addWorklog({
      issueIdOrKey: key,
      timeSpentSeconds: input.timeSpentSeconds,
      started: input.startedAt ?? new Date().toISOString(),
      ...(input.comment
        ? { comment: jiraTextInputToAdf(input.comment) as never }
        : {}),
    });
    return this.ticket(key, true);
  }

  async linkTickets(input: {
    inwardIssueKey: string;
    outwardIssueKey: string;
    linkType: string;
  }): Promise<JiraTicketDetail> {
    const inwardIssueKey = normalizeIssueKey(input.inwardIssueKey);
    const outwardIssueKey = normalizeIssueKey(input.outwardIssueKey);
    const linkType = input.linkType.trim();
    if (!linkType) throw new Error("Jira issue link type is required");
    const { cloud } = await this.getClients();
    await cloud.issueLinks.linkIssues({
      type: { name: linkType },
      inwardIssue: { key: inwardIssueKey },
      outwardIssue: { key: outwardIssueKey },
    });
    return this.ticket(inwardIssueKey, true);
  }

  async branchTicket(issueKey: string): Promise<JiraBranchTicket> {
    const key = normalizeIssueKey(issueKey);
    const projectKey = key.replace(/-\d+$/, "");
    const prisma = await getPrismaClient();
    const project = await prisma.jiraProject.findUnique({
      where: { key: projectKey },
      select: { key: true, branchNamingScript: true },
    });
    if (!project) {
      throw new Error(
        `Jira project ${projectKey} is not managed; add it in Manage Jira projects and sources`,
      );
    }
    const result = await this.cachedCall<RawIssue>({
      operation: "ISSUE_BRANCH",
      params: { issueKey: key, fields: ["summary", "issuetype", "project"] },
      requestSummary: `Branch details for ${key}`,
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.issues.getIssue({
          issueIdOrKey: key,
          fields: ["summary", "issuetype", "project"],
          updateHistory: false,
        });
      },
    });
    await this.linkCacheEntryToIssue(key, result.entryId);
    const fields = asRecord(result.value.fields);
    const returnedKey =
      asString(asRecord(fields.project).key) ??
      projectKeyForIssue(result.value);
    if (returnedKey !== project.key) {
      throw new Error(
        `Jira ticket ${key} does not belong to project ${project.key}`,
      );
    }
    return {
      ticketKey: result.value.key ?? key,
      ticketTitle: asString(fields.summary) ?? key,
      ticketType: asString(asRecord(fields.issuetype).name),
      projectKey: project.key,
      branchNamingScript:
        project.branchNamingScript ?? DEFAULT_JIRA_BRANCH_NAMING_SCRIPT,
    };
  }

  async clearCache(): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.$transaction([
      prisma.jiraCacheEntry.deleteMany(),
      prisma.jiraCachedTicket.deleteMany(),
    ]);
    return true;
  }

  async clearApiCalls(): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.jiraApiCallLog.deleteMany();
    return true;
  }

  async deleteCachedTicket(issueKey: string): Promise<boolean> {
    await this.invalidateIssueCaches(normalizeIssueKey(issueKey));
    return true;
  }

  private async invalidateIssueCaches(issueKey: string): Promise<void> {
    const prisma = await getPrismaClient();
    const links = await prisma.jiraCacheEntryIssue.findMany({
      where: { issueKey },
      select: { cacheEntryId: true },
    });
    await prisma.$transaction(async (transaction) => {
      if (links.length > 0) {
        await transaction.jiraCacheEntry.deleteMany({
          where: { id: { in: links.map((link) => link.cacheEntryId) } },
        });
      }
      await transaction.jiraCachedTicket.deleteMany({ where: { issueKey } });
    });
  }

  async refreshCachedTicket(
    issueKey: string,
    changelog?: JiraWebhookChangelog | null,
  ): Promise<JiraTicketDetail> {
    const prisma = await getPrismaClient();
    const links = await prisma.jiraCacheEntryIssue.findMany({
      where: { issueKey },
      select: { cacheEntryId: true },
    });
    if (links.length > 0) {
      await prisma.jiraCacheEntry.deleteMany({
        where: { id: { in: links.map((link) => link.cacheEntryId) } },
      });
    }
    return this.ticket(issueKey, true, changelog);
  }

  async resolveIssueKeys(issueIds: string[]): Promise<string[]> {
    const ids = [
      ...new Set(issueIds.map((issueId) => issueId.trim()).filter(Boolean)),
    ];
    if (ids.length === 0) return [];
    const { cloud } = await this.getClients();
    const issues = await Promise.all(
      ids.map((issueId) =>
        cloud.issues.getIssue({
          issueIdOrKey: issueId,
          fields: ["key"],
        }),
      ),
    );
    return [
      ...new Set(
        issues.map((issue) => {
          const key = asString(issue.key);
          if (!key) throw new Error(`Jira issue ${issue.id ?? ""} has no key`);
          return normalizeIssueKey(key);
        }),
      ),
    ];
  }

  async refreshSprintTickets(sprintId: number): Promise<JiraTicketDetail[]> {
    if (!Number.isSafeInteger(sprintId) || sprintId <= 0) {
      throw new Error("Invalid Jira sprint ID");
    }
    const { agile } = await this.getClients();
    const issueKeys: string[] = [];
    let nextPageToken: string | undefined;
    while (issueKeys.length < MAX_ISSUES) {
      const maxResults = Math.min(PAGE_SIZE, MAX_ISSUES - issueKeys.length);
      const page = await agile.sprint.getIssuesForSprint({
        sprintId,
        nextPageToken,
        maxResults,
        // Jira's REST API accepts field names here, while jira.js 6.1's
        // generated Agile input type incorrectly describes them as objects.
        fields: ["key"] as never,
      });
      const issues = page.issues ?? [];
      issueKeys.push(
        ...issues.flatMap((issue) => {
          const key = asString(issue.key);
          return key ? [normalizeIssueKey(key)] : [];
        }),
      );
      const pageToken = asString(page.nextPageToken) ?? undefined;
      if (issues.length === 0 || page.isLast || !pageToken) break;
      if (pageToken === nextPageToken) {
        throw new Error("Jira returned a repeated sprint pagination token");
      }
      nextPageToken = pageToken;
    }

    const tickets: JiraTicketDetail[] = [];
    const uniqueKeys = [...new Set(issueKeys)];
    for (let index = 0; index < uniqueKeys.length; index += 5) {
      tickets.push(
        ...(await Promise.all(
          uniqueKeys
            .slice(index, index + 5)
            .map((issueKey) => this.refreshCachedTicket(issueKey)),
        )),
      );
    }
    return tickets;
  }

  async listCachedTickets(
    limit = 50,
    offset = 0,
  ): Promise<PaginatedResult<JiraCachedTicketView>> {
    const pagination = this.validatePagination(limit, offset);
    const prisma = await getPrismaClient();
    const [tickets, total, settings] = await Promise.all([
      prisma.jiraCachedTicket.findMany({
        take: pagination.limit,
        skip: pagination.offset,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.jiraCachedTicket.count(),
      this.getSettings(),
    ]);
    return {
      ...pagination,
      total,
      items: tickets.map((ticket) =>
        this.cachedTicketView(ticket, settings.cacheTtlSeconds),
      ),
    };
  }

  async cachedTicket(issueKey: string): Promise<JiraCachedTicketDetail | null> {
    const prisma = await getPrismaClient();
    const [ticket, settings] = await Promise.all([
      prisma.jiraCachedTicket.findUnique({
        where: { issueKey },
        include: { cacheEntries: { include: { cacheEntry: true } } },
      }),
      this.getSettings(),
    ]);
    if (!ticket) return null;
    return {
      ...this.cachedTicketView(ticket, settings.cacheTtlSeconds),
      summaryData: parseJson(ticket.summaryJson),
      detailData: parseJson(ticket.detailJson),
      commentsData: parseJson(ticket.commentsJson),
      cacheEntries: ticket.cacheEntries
        .map((link) => ({
          id: link.cacheEntry.id,
          operation: link.cacheEntry.operation,
          fetchedAt: link.cacheEntry.fetchedAt.toISOString(),
        }))
        .sort((first, second) =>
          second.fetchedAt.localeCompare(first.fetchedAt),
        ),
    };
  }

  async listApiCalls(
    limit = 50,
    offset = 0,
  ): Promise<PaginatedResult<JiraApiCallView>> {
    const pagination = this.validatePagination(limit, offset);
    await this.pruneLogs();
    const prisma = await getPrismaClient();
    const [calls, total] = await Promise.all([
      prisma.jiraApiCallLog.findMany({
        take: pagination.limit,
        skip: pagination.offset,
        orderBy: { createdAt: "desc" },
      }),
      prisma.jiraApiCallLog.count(),
    ]);
    return {
      ...pagination,
      total,
      items: calls.map((call) => ({
        id: call.id,
        operation: call.operation,
        requestSummary: call.requestSummary,
        source: call.source as JiraCallSource,
        durationMs: call.durationMs,
        statusCode: call.statusCode,
        error: call.error,
        itemCount: call.itemCount,
        servedStale: call.servedStale,
        createdAt: call.createdAt.toISOString(),
      })),
    };
  }

  async cacheMetrics(): Promise<JiraCacheMetrics> {
    await this.pruneLogs();
    const prisma = await getPrismaClient();
    const now = Date.now();
    const calls = await prisma.jiraApiCallLog.findMany({
      where: {
        createdAt: {
          gte: new Date(now - WINDOW_DEFINITIONS.at(-1)!.milliseconds),
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const windows = WINDOW_DEFINITIONS.map((definition) =>
      this.metricWindow(
        definition.window,
        calls.filter(
          (call) => call.createdAt.getTime() >= now - definition.milliseconds,
        ),
      ),
    );
    const operations = [...new Set(calls.map((call) => call.operation))].sort();
    const operationRows: JiraOperationMetric[] = operations.map(
      (operation) => ({
        operation,
        windows: WINDOW_DEFINITIONS.map((definition) =>
          this.metricWindow(
            definition.window,
            calls.filter(
              (call) =>
                call.operation === operation &&
                call.createdAt.getTime() >= now - definition.milliseconds,
            ),
          ),
        ),
      }),
    );
    return { windows, operations: operationRows };
  }

  private async requireCredentials() {
    const prisma = await getPrismaClient();
    const [settings, connection] = await Promise.all([
      prisma.jiraSettings.findUnique({ where: { id: SETTINGS_ID } }),
      this.storedConnection(),
    ]);
    if (!connection) {
      throw new Error(
        "Configure the Jira site, email, and API token in Settings first",
      );
    }
    const apiToken = await this.credentials.getText(CREDENTIALS.jiraApiToken);
    if (!apiToken) {
      throw new Error(
        "Configure the Jira site, email, and API token in Settings first",
      );
    }
    return {
      siteUrl: connection.value.siteUrl,
      email: connection.value.email,
      apiToken,
      cacheTtlSeconds: settings?.cacheTtlSeconds ?? DEFAULT_TTL_SECONDS,
    };
  }

  private async getClients() {
    const settings = await this.requireCredentials();
    const key = createHash("sha256")
      .update(`${settings.siteUrl}\0${settings.email}\0${settings.apiToken}`)
      .digest("hex");
    if (this.clients?.key === key) return this.clients;
    const client = createClient({
      host: settings.siteUrl,
      auth: {
        type: "basic",
        email: settings.email,
        apiToken: settings.apiToken,
      },
    });
    this.clients = {
      key,
      cloud: createCloudClient(client),
      agile: createAgileClient(client),
    };
    return this.clients;
  }

  /**
   * Calls Jira's classic webhook REST API (`/rest/webhooks/1.0/webhook`).
   *
   * `jira.js` only wraps the dynamic webhook API (`/rest/api/3/webhook`), which
   * refuses anything but OAuth 2.0 and expires registrations after 30 days. The
   * 1.0 API accepts the same basic auth as every other call in this service, so
   * an API token belonging to a Jira admin is enough to register a webhook.
   *
   * Resolves to the parsed JSON body, or null when Jira answers without one
   * (DELETE returns 204). Errors are sanitized so a token never reaches a log.
   */
  async webhookApiRequest<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const settings = await this.requireCredentials();
    const authorization = Buffer.from(
      `${settings.email}:${settings.apiToken}`,
    ).toString("base64");
    let response: Response;
    try {
      response = await fetch(`${settings.siteUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${authorization}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(sanitizeError(error, settings.apiToken));
    }
    const payload = await response.text();
    if (!response.ok) {
      // 403 here almost always means the token's user is not a Jira admin,
      // which is the one failure the UI cannot fix on the user's behalf.
      const detail = payload.trim().slice(0, 300) || response.statusText;
      throw Object.assign(
        new Error(
          sanitizeError(
            `Jira rejected the webhook request with ${response.status}: ${detail}`,
            settings.apiToken,
          ),
        ),
        { status: response.status },
      );
    }
    if (!payload.trim()) return null;
    try {
      return JSON.parse(payload) as T;
    } catch {
      return null;
    }
  }

  private async currentAccountId(): Promise<string> {
    const result = await this.cachedCall({
      operation: "MYSELF",
      params: {},
      requestSummary: "Current Jira user",
      fetcher: async () => {
        const { cloud } = await this.getClients();
        return cloud.myself.getCurrentUser();
      },
    });
    const accountId = asString(asRecord(result.value).accountId);
    if (!accountId) throw new Error("Jira did not return the current user ID");
    return accountId;
  }

  private async linkCacheEntryToIssue(issueKey: string, cacheEntryId: string) {
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      await transaction.jiraCachedTicket.upsert({
        where: { issueKey },
        create: {
          issueKey,
          projectKey: issueKey.replace(/-\d+$/, ""),
        },
        update: {},
      });
      await transaction.jiraCacheEntryIssue.upsert({
        where: { cacheEntryId_issueKey: { cacheEntryId, issueKey } },
        create: { cacheEntryId, issueKey },
        update: {},
      });
    });
  }

  private async mutateTicket(
    issueKey: string,
    operation: string,
    mutation: () => Promise<void>,
  ): Promise<JiraTicketDetail> {
    const settings = await this.requireCredentials();
    const startedAt = Date.now();
    try {
      await mutation();
      await this.logCall({
        operation,
        requestSummary: `${operation.replaceAll("_", " ")} for ${issueKey}`,
        source: "LIVE",
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = sanitizeError(error, settings.apiToken);
      await this.logCall({
        operation,
        requestSummary: `${operation.replaceAll("_", " ")} for ${issueKey}`,
        source: "ERROR",
        durationMs: Date.now() - startedAt,
        statusCode: errorStatus(error),
        error: message,
      });
      throw new Error(message);
    }
    await this.invalidateIssueCaches(issueKey);
    let ticket: JiraTicketDetail;
    try {
      ticket = await this.ticket(issueKey, true);
    } catch (error) {
      throw new Error(
        `Jira accepted the update, but refreshed ticket details could not be loaded: ${sanitizeError(error, settings.apiToken)}`,
      );
    }
    agentEventBus.publish(JIRA_TICKET_CHANGED_TOPIC, {
      jiraTicketChanged: {
        issueKey: ticket.key,
        projectKey: ticket.projectKey,
        event: `aide:${operation.toLowerCase()}`,
      } satisfies JiraTicketChange,
    });
    return ticket;
  }

  private cacheKey(
    siteUrl: string,
    operation: string,
    params: JsonRecord,
  ): string {
    return createHash("sha256")
      .update(stableStringify({ siteUrl, operation, params }))
      .digest("hex");
  }

  private async cachedCall<T>(call: CacheCall<T>): Promise<CacheResult<T>> {
    const settings = await this.requireCredentials();
    const prisma = await getPrismaClient();
    const key = this.cacheKey(settings.siteUrl, call.operation, call.params);
    const startedAt = Date.now();
    const existing = await prisma.jiraCacheEntry.findUnique({
      where: { cacheKey: key },
    });
    const fresh =
      existing !== null &&
      Date.now() - existing.fetchedAt.getTime() <
        settings.cacheTtlSeconds * 1000;
    if (!call.force && fresh) {
      await this.logCall({
        operation: call.operation,
        requestSummary: call.requestSummary,
        source: "CACHE",
        durationMs: Date.now() - startedAt,
        itemCount:
          call.itemCount?.(parseJson(existing.responseJson) as T) ?? null,
        sourceId: call.sourceId,
      });
      return {
        value: parseJson(existing.responseJson) as T,
        source: "CACHE",
        stale: false,
        fetchedAt: existing.fetchedAt,
        entryId: existing.id,
      };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      const result = (await pending) as CacheResult<T>;
      await this.logCall({
        operation: call.operation,
        requestSummary: `${call.requestSummary} (coalesced)`,
        source: "CACHE",
        durationMs: Date.now() - startedAt,
        itemCount: call.itemCount?.(result.value) ?? null,
        sourceId: call.sourceId,
      });
      return { ...result, source: "CACHE" };
    }

    const livePromise = (async (): Promise<CacheResult<T>> => {
      try {
        const value = await call.fetcher();
        const fetchedAt = new Date();
        const entry = await prisma.jiraCacheEntry.upsert({
          where: { cacheKey: key },
          create: {
            id: randomUUID(),
            cacheKey: key,
            operation: call.operation,
            paramsJson: stableStringify(call.params),
            responseJson: JSON.stringify(value),
            fetchedAt,
            sourceId: call.sourceId ?? null,
          },
          update: {
            operation: call.operation,
            paramsJson: stableStringify(call.params),
            responseJson: JSON.stringify(value),
            fetchedAt,
            sourceId: call.sourceId ?? null,
          },
        });
        await this.logCall({
          operation: call.operation,
          requestSummary: call.requestSummary,
          source: "LIVE",
          durationMs: Date.now() - startedAt,
          itemCount: call.itemCount?.(value) ?? null,
          sourceId: call.sourceId,
        });
        return {
          value,
          source: "LIVE",
          stale: false,
          fetchedAt,
          entryId: entry.id,
        };
      } catch (error) {
        const canServeStale =
          existing !== null && call.allowStaleOnError !== false;
        await this.logCall({
          operation: call.operation,
          requestSummary: call.requestSummary,
          source: "ERROR",
          durationMs: Date.now() - startedAt,
          statusCode: errorStatus(error),
          error: sanitizeError(error, settings.apiToken),
          servedStale: canServeStale,
          sourceId: call.sourceId,
        });
        if (canServeStale) {
          return {
            value: parseJson(existing.responseJson) as T,
            source: "ERROR",
            stale: true,
            fetchedAt: existing.fetchedAt,
            entryId: existing.id,
          };
        }
        throw new Error(sanitizeError(error, settings.apiToken));
      }
    })();
    this.inFlight.set(key, livePromise as Promise<CacheResult<unknown>>);
    try {
      return await livePromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async logCall(input: {
    operation: string;
    requestSummary: string;
    source: JiraCallSource;
    durationMs: number;
    statusCode?: number | null;
    error?: string | null;
    itemCount?: number | null;
    servedStale?: boolean;
    sourceId?: string | null;
  }) {
    if (!this.recordCallLogs) return;
    const prisma = await getPrismaClient();
    await prisma.jiraApiCallLog.create({
      data: {
        id: randomUUID(),
        operation: input.operation,
        requestSummary: input.requestSummary.slice(0, 1000),
        source: input.source,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        statusCode: input.statusCode ?? null,
        error: input.error ?? null,
        itemCount: input.itemCount ?? null,
        servedStale: input.servedStale ?? false,
        sourceId: input.sourceId ?? null,
      },
    });
  }

  private validateSourceName(value: string): string {
    const name = value.trim();
    if (!name || name.length > 100)
      throw new Error("Source name must be 1 to 100 characters");
    return name;
  }

  private async validateSource(kind: JiraSourceKind, rawValue: string) {
    const value = rawValue.trim();
    if (!value)
      throw new Error(
        kind === "BOARD" ? "Board URL is required" : "JQL is required",
      );
    if (kind === "JQL") {
      await this.cachedCall({
        operation: "JQL_VALIDATE",
        params: { jql: value },
        requestSummary: `Validate JQL: ${value}`,
        fetcher: async () => {
          const { cloud } = await this.getClients();
          return cloud.issueSearch.searchAndReconsileIssuesUsingJql({
            jql: value,
            maxResults: 1,
            fields: ["key"],
            failFast: true,
          });
        },
      });
      return { value, boardId: null };
    }
    const settings = await this.requireCredentials();
    const parsed = parseJiraBoardUrl(value, settings.siteUrl);
    await this.cachedCall({
      operation: "BOARD",
      params: { boardId: parsed.boardId },
      requestSummary: `Board ${parsed.boardId}`,
      fetcher: async () => {
        const { agile } = await this.getClients();
        return agile.board.getBoard({ boardId: parsed.boardId });
      },
    });
    return { value: parsed.normalizedUrl, boardId: parsed.boardId };
  }

  private async loadJqlSource(source: JiraSourceView, force: boolean) {
    const issues: RawIssue[] = [];
    const results: CacheResult<unknown>[] = [];
    const warnings: string[] = [];
    let nextPageToken: string | undefined;
    let truncated = false;
    do {
      const remaining = MAX_ISSUES - issues.length;
      const maxResults = Math.min(PAGE_SIZE, remaining);
      const result = await this.cachedCall<RawSearchPage>({
        operation: "JQL_SEARCH",
        params: {
          jql: source.value,
          nextPageToken: nextPageToken ?? null,
          maxResults,
          fields: LIST_FIELDS,
        },
        requestSummary: `JQL ${source.name}${nextPageToken ? " next page" : ""}`,
        sourceId: source.id,
        force,
        fetcher: async () => {
          const { cloud } = await this.getClients();
          return cloud.issueSearch.searchAndReconsileIssuesUsingJql({
            jql: source.value,
            nextPageToken,
            maxResults,
            fields: LIST_FIELDS,
          });
        },
        itemCount: (value) => value.issues?.length ?? 0,
      });
      results.push(result);
      const pageIssues = result.value.issues ?? [];
      issues.push(...pageIssues);
      warnings.push(...searchWarnings(result.value));
      if (result.source === "LIVE") {
        await this.storeSummaries(result.entryId, pageIssues, result.fetchedAt);
      }
      const pageToken = asString(result.value.nextPageToken) ?? undefined;
      const hasMore = result.value.isLast !== true && Boolean(pageToken);
      if (hasMore && pageToken === nextPageToken) {
        warnings.push("Jira returned a repeated JQL pagination token.");
        nextPageToken = undefined;
      } else {
        nextPageToken = hasMore ? pageToken : undefined;
      }
      if (issues.length >= MAX_ISSUES && nextPageToken) truncated = true;
    } while (nextPageToken && issues.length < MAX_ISSUES);
    return this.buildBoardResult(issues, results, warnings, truncated);
  }

  private async loadBoardSource(source: JiraSourceView, force: boolean) {
    if (!source.boardId) throw new Error("Saved board source has no board ID");
    const board = await this.cachedCall<JsonRecord>({
      operation: "BOARD",
      params: { boardId: source.boardId },
      requestSummary: `Board ${source.boardId}`,
      sourceId: source.id,
      force,
      fetcher: async () => {
        const { agile } = await this.getClients();
        return agile.board.getBoard({ boardId: source.boardId! });
      },
    });
    const configuration = await this.cachedCall<JsonRecord>({
      operation: "BOARD_CONFIGURATION",
      params: { boardId: source.boardId },
      requestSummary: `Board ${source.boardId} configuration`,
      sourceId: source.id,
      force,
      fetcher: async () => {
        const { agile } = await this.getClients();
        return agile.board.getConfiguration({
          boardId: source.boardId!,
        });
      },
    });
    const results: CacheResult<unknown>[] = [board, configuration];
    const issues: RawIssue[] = [];
    const warnings: string[] = [];
    let truncated = false;
    if ((asString(board.value.type) ?? "").toLowerCase() === "scrum") {
      const sprintResult = await this.cachedCall<JsonRecord>({
        operation: "SPRINTS",
        params: { boardId: source.boardId, state: "active" },
        requestSummary: `Active sprints for board ${source.boardId}`,
        sourceId: source.id,
        force,
        fetcher: async () => {
          const { agile } = await this.getClients();
          return agile.board.getAllSprints({
            boardId: source.boardId!,
            state: "active",
            startAt: 0,
            maxResults: PAGE_SIZE,
          });
        },
        itemCount: (value) => asArray(value.values).length,
      });
      results.push(sprintResult);
      const sprints = asArray(sprintResult.value.values).map(asRecord);
      if (sprints.length === 0)
        warnings.push("This Scrum board has no active sprint.");
      for (const sprint of sprints) {
        const sprintId = asNumber(sprint.id);
        if (!sprintId || issues.length >= MAX_ISSUES) continue;
        const loaded = await this.loadAgileIssues(
          "SPRINT_ISSUES",
          source,
          force,
          (nextPageToken, maxResults) => ({
            sprintId,
            nextPageToken,
            maxResults,
            fields: LIST_FIELDS,
          }),
          async (parameters) => {
            const { agile } = await this.getClients();
            return agile.sprint.getIssuesForSprint(parameters);
          },
          issues.length,
        );
        issues.push(...loaded.issues);
        results.push(...loaded.results);
        warnings.push(...loaded.warnings);
        truncated ||= loaded.truncated;
      }
    } else {
      const loaded = await this.loadAgileIssues(
        "BOARD_ISSUES",
        source,
        force,
        (nextPageToken, maxResults) => ({
          boardId: source.boardId!,
          nextPageToken,
          maxResults,
          fields: LIST_FIELDS,
        }),
        async (parameters) => {
          const { agile } = await this.getClients();
          return agile.board.getIssuesForBoard(parameters);
        },
        0,
      );
      issues.push(...loaded.issues);
      results.push(...loaded.results);
      warnings.push(...loaded.warnings);
      truncated = loaded.truncated;
    }
    const unique = [
      ...new Map(
        issues.map((issue) => [issue.key ?? issue.id, issue]),
      ).values(),
    ];
    const columnOrder = new Map<string, number>();
    asArray(asRecord(configuration.value.columnConfig).columns)
      .map(asRecord)
      .forEach((column, columnIndex) => {
        asArray(column.statuses)
          .map(asRecord)
          .forEach((status) => {
            const id = asString(status.id);
            if (id) columnOrder.set(id, columnIndex);
          });
      });
    return this.buildBoardResult(
      unique,
      results,
      warnings,
      truncated,
      columnOrder,
    );
  }

  private async loadAgileIssues(
    operation: string,
    source: JiraSourceView,
    force: boolean,
    params: (
      nextPageToken: string | undefined,
      maxResults: number,
    ) => JsonRecord,
    fetcher: (parameters: never) => Promise<RawSearchPage>,
    alreadyLoaded: number,
  ) {
    const issues: RawIssue[] = [];
    const results: CacheResult<unknown>[] = [];
    const warnings: string[] = [];
    let nextPageToken: string | undefined;
    let truncated = false;
    while (issues.length + alreadyLoaded < MAX_ISSUES) {
      const maxResults = Math.min(
        PAGE_SIZE,
        MAX_ISSUES - alreadyLoaded - issues.length,
      );
      const parameters = params(nextPageToken, maxResults);
      const result = await this.cachedCall<RawSearchPage>({
        operation,
        params: parameters,
        requestSummary: `${operation.replaceAll("_", " ")}${nextPageToken ? " next page" : ""}`,
        sourceId: source.id,
        force,
        fetcher: () => fetcher(parameters as never),
        itemCount: (value) => value.issues?.length ?? 0,
      });
      results.push(result);
      const pageIssues = result.value.issues ?? [];
      issues.push(...pageIssues);
      warnings.push(...searchWarnings(result.value));
      if (result.source === "LIVE")
        await this.storeSummaries(result.entryId, pageIssues, result.fetchedAt);
      const pageToken = asString(result.value.nextPageToken) ?? undefined;
      const hasMore = result.value.isLast !== true && Boolean(pageToken);
      if (pageIssues.length === 0 || !hasMore) {
        nextPageToken = undefined;
        break;
      }
      if (pageToken === nextPageToken) {
        warnings.push("Jira returned a repeated Agile pagination token.");
        nextPageToken = undefined;
        break;
      }
      nextPageToken = pageToken;
    }
    if (issues.length + alreadyLoaded >= MAX_ISSUES && nextPageToken) {
      truncated = true;
    }
    return { issues, results, warnings, truncated };
  }

  private buildBoardResult(
    issues: RawIssue[],
    results: CacheResult<unknown>[],
    warnings: string[],
    truncated: boolean,
    columnOrder?: Map<string, number>,
  ) {
    const tickets = issues.slice(0, MAX_ISSUES).map(ticketSummary);
    const statuses = [
      ...new Map(tickets.map((ticket) => [ticket.status, ticket])).values(),
    ];
    statuses.sort((first, second) => {
      const firstColumn = columnOrder?.get(first.statusId);
      const secondColumn = columnOrder?.get(second.statusId);
      if (firstColumn !== undefined || secondColumn !== undefined) {
        return (
          (firstColumn ?? Number.MAX_SAFE_INTEGER) -
          (secondColumn ?? Number.MAX_SAFE_INTEGER)
        );
      }
      return (
        categoryRank(first.statusCategory) -
          categoryRank(second.statusCategory) ||
        first.status.localeCompare(second.status)
      );
    });
    return {
      tickets,
      statusOrder: statuses.map((status) => status.status),
      cache: combineCacheMeta(results),
      truncated,
      warnings: [...new Set(warnings)],
    };
  }

  private async storeSummaries(
    entryId: string,
    issues: RawIssue[],
    fetchedAt: Date,
  ) {
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      for (const issue of issues) {
        if (!issue.key) continue;
        await transaction.jiraCachedTicket.upsert({
          where: { issueKey: issue.key },
          create: {
            issueKey: issue.key,
            projectKey: projectKeyForIssue(issue),
            summaryJson: JSON.stringify(issue),
            summaryFetchedAt: fetchedAt,
          },
          update: {
            projectKey: projectKeyForIssue(issue),
            summaryJson: JSON.stringify(issue),
            summaryFetchedAt: fetchedAt,
          },
        });
      }
      await transaction.jiraCacheEntryIssue.deleteMany({
        where: { cacheEntryId: entryId },
      });
      const issueKeys = [
        ...new Set(issues.map((issue) => issue.key).filter(Boolean)),
      ];
      if (issueKeys.length > 0) {
        await transaction.jiraCacheEntryIssue.createMany({
          data: issueKeys.map((issueKey) => ({
            cacheEntryId: entryId,
            issueKey: issueKey!,
          })),
        });
      }
    });
  }

  private async storeDetail(entryId: string, issue: RawIssue, fetchedAt: Date) {
    if (!issue.key)
      throw new Error("Jira detail response did not include an issue key");
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      await transaction.jiraCachedTicket.upsert({
        where: { issueKey: issue.key! },
        create: {
          issueKey: issue.key!,
          projectKey: projectKeyForIssue(issue),
          detailJson: JSON.stringify(issue),
          detailFetchedAt: fetchedAt,
        },
        update: {
          projectKey: projectKeyForIssue(issue),
          detailJson: JSON.stringify(issue),
          detailFetchedAt: fetchedAt,
        },
      });
      await transaction.jiraCacheEntryIssue.upsert({
        where: {
          cacheEntryId_issueKey: {
            cacheEntryId: entryId,
            issueKey: issue.key!,
          },
        },
        create: { cacheEntryId: entryId, issueKey: issue.key! },
        update: {},
      });
    });
  }

  private async storeComments(
    issueKey: string,
    comments: unknown[],
    fetchedAt: Date,
    entryIds: string[],
  ) {
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      await transaction.jiraCachedTicket.upsert({
        where: { issueKey },
        create: {
          issueKey,
          projectKey: issueKey.split("-")[0] ?? "UNKNOWN",
          commentsJson: JSON.stringify(comments),
          commentsFetchedAt: fetchedAt,
        },
        update: {
          commentsJson: JSON.stringify(comments),
          commentsFetchedAt: fetchedAt,
        },
      });
      for (const entryId of entryIds) {
        await transaction.jiraCacheEntryIssue.upsert({
          where: { cacheEntryId_issueKey: { cacheEntryId: entryId, issueKey } },
          create: { cacheEntryId: entryId, issueKey },
          update: {},
        });
      }
    });
  }

  private normalizeTicketDetail(
    issue: RawIssue,
    rawComments: unknown[],
    siteUrl: string,
    detailCache: JiraCacheMeta,
    commentsCache: JiraCacheMeta,
  ): JiraTicketDetail {
    const summary = ticketSummary(issue);
    const fields = asRecord(issue.fields);
    const fieldNames = asRecord(issue.names);
    const fieldSchemas = asRecord(issue.schema);
    const links: JiraIssueLinkView[] = [];
    for (const rawLink of asArray(fields.issuelinks).map(asRecord)) {
      const type = asRecord(rawLink.type);
      const outward = issueLink(
        rawLink.outwardIssue,
        asString(type.outward) ?? "relates to",
      );
      const inward = issueLink(
        rawLink.inwardIssue,
        asString(type.inward) ?? "relates to",
      );
      if (outward) links.push(outward);
      if (inward) links.push(inward);
    }
    const parent = issueLink(fields.parent, "parent");
    const subtasks = asArray(fields.subtasks)
      .map((subtask) => issueLink(subtask, "subtask"))
      .filter((link): link is JiraIssueLinkView => link !== null);
    const sprintValues = asArray(fields.sprint).map(asRecord);
    const closedSprintValues = asArray(fields.closedSprints).map(asRecord);
    const activeSprintNames = sprintValues
      .filter((sprint) => {
        const state = asString(sprint.state)?.toLowerCase();
        return !state || state === "active";
      })
      .map((sprint) => asString(sprint.name))
      .filter((name): name is string => Boolean(name));
    const closedSprintNames = closedSprintValues
      .concat(
        sprintValues.filter(
          (sprint) => asString(sprint.state)?.toLowerCase() === "closed",
        ),
      )
      .map((sprint) => asString(sprint.name))
      .filter((name): name is string => Boolean(name));
    const sprintNames = activeSprintNames.concat(closedSprintNames);
    const comments: JiraCommentView[] = rawComments
      .map(asRecord)
      .map((comment) => ({
        id: asString(comment.id) ?? randomUUID(),
        author: person(comment.author),
        body: comment.body ?? null,
        content: normalizeJiraRichText(comment.body ?? null, siteUrl),
        createdAt: asString(comment.created),
        updatedAt: asString(comment.updated),
      }));
    return {
      ...summary,
      jiraUrl: `${siteUrl}/browse/${summary.key}`,
      description: fields.description ?? null,
      descriptionContent: normalizeJiraRichText(
        fields.description ?? null,
        siteUrl,
      ),
      reporter: person(fields.reporter),
      creator: person(fields.creator),
      labels: asArray(fields.labels).filter(
        (label): label is string => typeof label === "string",
      ),
      components: namedValues(fields.components),
      fixVersions: namedValues(fields.fixVersions),
      affectedVersions: namedValues(fields.versions),
      sprintNames: [...new Set(sprintNames)],
      activeSprintNames: [...new Set(activeSprintNames)],
      closedSprintNames: [...new Set(closedSprintNames)],
      parent,
      subtasks,
      issueLinks: links,
      attachments: asArray(fields.attachment)
        .map(asRecord)
        .map((attachment) => ({
          id: asString(attachment.id) ?? randomUUID(),
          filename: asString(attachment.filename) ?? "Attachment",
          contentUrl: asString(attachment.content),
          mimeType: asString(attachment.mimeType),
          size: asNumber(attachment.size),
          author: person(attachment.author),
          createdAt: asString(attachment.created),
        })),
      comments,
      createdAt: asString(fields.created),
      dueAt: asString(fields.duedate),
      resolvedAt: asString(fields.resolutiondate),
      timeTracking: fields.timetracking ?? null,
      allFields: Object.entries(fields)
        .map(([id, value]) => {
          const schema = asRecord(fieldSchemas[id]);
          const richValue =
            typeof value === "string" ||
            (isRecord(value) && value.type === "doc")
              ? normalizeJiraRichText(value, siteUrl)
              : null;
          return {
            id,
            name: asString(fieldNames[id]) ?? id,
            schemaType: asString(schema.type),
            custom: asBoolean(schema.custom) || id.startsWith("customfield_"),
            value: value ?? null,
            content: richValue,
          };
        })
        .sort((first, second) => first.name.localeCompare(second.name)),
      cache: detailCache,
      commentsCache,
    };
  }

  private cachedTicketView(
    ticket: {
      issueKey: string;
      projectKey: string;
      summaryJson: string | null;
      summaryFetchedAt: Date | null;
      detailJson: string | null;
      detailFetchedAt: Date | null;
      commentsJson: string | null;
      commentsFetchedAt: Date | null;
      updatedAt: Date;
    },
    ttlSeconds: number,
  ): JiraCachedTicketView {
    const best = asRecord(
      parseJson(ticket.detailJson) ?? parseJson(ticket.summaryJson),
    );
    const summary = ticketSummary(best as RawIssue);
    const coverage =
      ticket.detailJson && ticket.commentsJson
        ? "FULL"
        : ticket.detailJson
          ? "DETAIL"
          : "SUMMARY";
    const relevantDates = [
      ticket.summaryFetchedAt,
      ticket.detailFetchedAt,
      ticket.commentsFetchedAt,
    ].filter((date): date is Date => date !== null);
    const stale = relevantDates.some(
      (date) => Date.now() - date.getTime() >= ttlSeconds * 1000,
    );
    return {
      issueKey: ticket.issueKey,
      projectKey: ticket.projectKey,
      summary: summary.summary,
      status: summary.status === "Unknown" ? null : summary.status,
      coverage,
      stale,
      summaryFetchedAt: ticket.summaryFetchedAt?.toISOString() ?? null,
      detailFetchedAt: ticket.detailFetchedAt?.toISOString() ?? null,
      commentsFetchedAt: ticket.commentsFetchedAt?.toISOString() ?? null,
      updatedAt: ticket.updatedAt.toISOString(),
    };
  }

  private validatePagination(limit: number, offset: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Pagination limit must be from 1 to 100");
    }
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error("Pagination offset must be non-negative");
    return { limit, offset };
  }

  private metricWindow(
    window: JiraMetricWindow["window"],
    calls: Array<{ source: string; durationMs: number }>,
  ): JiraMetricWindow {
    return {
      window,
      total: calls.length,
      live: calls.filter((call) => call.source === "LIVE").length,
      cache: calls.filter((call) => call.source === "CACHE").length,
      errors: calls.filter((call) => call.source === "ERROR").length,
      averageMs:
        calls.length === 0
          ? 0
          : Math.round(
              calls.reduce((sum, call) => sum + call.durationMs, 0) /
                calls.length,
            ),
    };
  }

  private async pruneLogs() {
    const now = Date.now();
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    const prisma = await getPrismaClient();
    await prisma.jiraApiCallLog.deleteMany({
      where: { createdAt: { lt: new Date(now - LOG_RETENTION_MS) } },
    });
  }
}
