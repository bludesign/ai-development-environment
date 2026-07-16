import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { AgileClient, Version3Client } from "jira.js";

import { getPrismaClient } from "@/data/prisma-client";

import type {
  JiraApiCallView,
  JiraAvailableProject,
  JiraCachedTicketDetail,
  JiraCachedTicketView,
  JiraCacheMeta,
  JiraCacheMetrics,
  JiraCallSource,
  JiraCommentView,
  JiraIssueLinkView,
  JiraMetricWindow,
  JiraNamedValue,
  JiraOperationMetric,
  JiraPerson,
  JiraProjectView,
  JiraSettingsView,
  JiraSourceKind,
  JiraSourceView,
  JiraTicketBoard,
  JiraTicketDetail,
  JiraTicketSummary,
  PaginatedResult,
} from "./types";

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
  startAt?: number;
  maxResults?: number;
  total?: number;
  nextPageToken?: string;
  warningMessages?: string[];
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
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
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

export class JiraService {
  private readonly inFlight = new Map<string, Promise<CacheResult<unknown>>>();
  private clients:
    { key: string; version3: Version3Client; agile: AgileClient } | undefined;
  private lastPrunedAt = 0;

  async getSettings(): Promise<JiraSettingsView> {
    const prisma = await getPrismaClient();
    const settings = await prisma.jiraSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, cacheTtlSeconds: DEFAULT_TTL_SECONDS },
      update: {},
    });
    return {
      siteUrl: settings.siteUrl,
      email: settings.email,
      tokenConfigured: Boolean(settings.apiToken),
      cacheTtlSeconds: settings.cacheTtlSeconds,
      updatedAt: settings.updatedAt.toISOString(),
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
    const existing = await prisma.jiraSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    const nextToken = input.apiToken?.trim() || existing?.apiToken || null;
    const siteChanged = Boolean(
      existing?.siteUrl && existing.siteUrl !== siteUrl,
    );
    if (siteChanged && !input.resetSite) {
      throw new Error("Changing the Jira site requires resetSite=true");
    }
    const credentialsChanged =
      existing?.siteUrl !== siteUrl ||
      existing?.email !== email ||
      existing?.apiToken !== nextToken;

    await prisma.$transaction(async (transaction) => {
      if (siteChanged) {
        await transaction.jiraProject.deleteMany();
      }
      if (credentialsChanged) {
        await transaction.jiraCacheEntry.deleteMany();
        await transaction.jiraCachedTicket.deleteMany();
      }
      await transaction.jiraSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          siteUrl,
          email,
          apiToken: nextToken,
          cacheTtlSeconds: DEFAULT_TTL_SECONDS,
        },
        update: { siteUrl, email, apiToken: nextToken },
      });
    });
    this.clients = undefined;
    return this.getSettings();
  }

  async clearCredentials(): Promise<JiraSettingsView> {
    const prisma = await getPrismaClient();
    await prisma.$transaction([
      prisma.jiraCacheEntry.deleteMany(),
      prisma.jiraCachedTicket.deleteMany(),
      prisma.jiraSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, cacheTtlSeconds: DEFAULT_TTL_SECONDS },
        update: { email: null, apiToken: null },
      }),
    ]);
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
      fetcher: async () => {
        const { version3 } = await this.getClients();
        return version3.myself.getCurrentUser();
      },
    });
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
      sources: project.sources.map(sourceView),
    }));
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
          const { version3 } = await this.getClients();
          return version3.projects.searchProjects({
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
        const { version3 } = await this.getClients();
        return version3.projects.getProject(id);
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
    });
    if (!source) throw new Error("Jira source not found");
    const loaded =
      source.kind === "BOARD"
        ? await this.loadBoardSource(sourceView(source), force)
        : await this.loadJqlSource(sourceView(source), force);
    return { source: sourceView(source), ...loaded };
  }

  async ticket(issueKey: string, force = false): Promise<JiraTicketDetail> {
    const key = issueKey.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))
      throw new Error("Invalid Jira issue key");
    const detail = await this.cachedCall<RawIssue>({
      operation: "ISSUE",
      params: { issueKey: key, fields: "*all", expand: "names,schema" },
      requestSummary: `Issue ${key} with all fields`,
      force,
      fetcher: async () => {
        const { version3 } = await this.getClients();
        return version3.issues.getIssue<RawIssue>({
          issueIdOrKey: key,
          fields: ["*all"],
          expand: ["name", "schema"],
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
          const { version3 } = await this.getClients();
          return version3.issueComments.getComments({
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
    return this.normalizeTicketDetail(
      detail.value,
      comments,
      settings.siteUrl,
      cacheMeta(detail),
      combineCacheMeta(commentResults),
    );
  }

  async clearCache(): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.$transaction([
      prisma.jiraCacheEntry.deleteMany(),
      prisma.jiraCachedTicket.deleteMany(),
    ]);
    return true;
  }

  async deleteCachedTicket(issueKey: string): Promise<boolean> {
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
    return true;
  }

  async refreshCachedTicket(issueKey: string): Promise<JiraTicketDetail> {
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
    return this.ticket(issueKey, true);
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
    const settings = await prisma.jiraSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (!settings?.siteUrl || !settings.email || !settings.apiToken) {
      throw new Error(
        "Configure the Jira site, email, and API token in Settings first",
      );
    }
    return {
      siteUrl: settings.siteUrl,
      email: settings.email,
      apiToken: settings.apiToken,
      cacheTtlSeconds: settings.cacheTtlSeconds,
    };
  }

  private async getClients() {
    const settings = await this.requireCredentials();
    const key = createHash("sha256")
      .update(`${settings.siteUrl}\0${settings.email}\0${settings.apiToken}`)
      .digest("hex");
    if (this.clients?.key === key) return this.clients;
    const config = {
      host: settings.siteUrl,
      authentication: {
        basic: { email: settings.email, apiToken: settings.apiToken },
      },
      baseRequestConfig: { timeout: 15_000 },
    } as const;
    this.clients = {
      key,
      version3: new Version3Client(config),
      agile: new AgileClient(config),
    };
    return this.clients;
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
        const canServeStale = existing !== null;
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
        if (existing) {
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
          const { version3 } = await this.getClients();
          return version3.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
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
          const { version3 } = await this.getClients();
          return version3.issueSearch.searchForIssuesUsingJqlEnhancedSearch<RawSearchPage>(
            {
              jql: source.value,
              nextPageToken,
              maxResults,
              fields: LIST_FIELDS,
            },
          );
        },
        itemCount: (value) => value.issues?.length ?? 0,
      });
      results.push(result);
      const pageIssues = result.value.issues ?? [];
      issues.push(...pageIssues);
      warnings.push(...(result.value.warningMessages ?? []));
      if (result.source === "LIVE") {
        await this.storeSummaries(result.entryId, pageIssues, result.fetchedAt);
      }
      nextPageToken = result.value.nextPageToken;
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
        return agile.board.getBoard<JsonRecord>({ boardId: source.boardId! });
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
        return agile.board.getConfiguration<JsonRecord>({
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
          return agile.board.getAllSprints<JsonRecord>({
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
          (startAt, maxResults) => ({
            sprintId,
            startAt,
            maxResults,
            fields: LIST_FIELDS,
          }),
          async (parameters) => {
            const { agile } = await this.getClients();
            return agile.sprint.getIssuesForSprint<RawSearchPage>(parameters);
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
        (startAt, maxResults) => ({
          boardId: source.boardId!,
          startAt,
          maxResults,
          fields: LIST_FIELDS,
        }),
        async (parameters) => {
          const { agile } = await this.getClients();
          return agile.board.getIssuesForBoard<RawSearchPage>(parameters);
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
    params: (startAt: number, maxResults: number) => JsonRecord,
    fetcher: (parameters: never) => Promise<RawSearchPage>,
    alreadyLoaded: number,
  ) {
    const issues: RawIssue[] = [];
    const results: CacheResult<unknown>[] = [];
    const warnings: string[] = [];
    let startAt = 0;
    let total = Number.POSITIVE_INFINITY;
    let truncated = false;
    while (startAt < total && issues.length + alreadyLoaded < MAX_ISSUES) {
      const maxResults = Math.min(
        PAGE_SIZE,
        MAX_ISSUES - alreadyLoaded - issues.length,
      );
      const parameters = params(startAt, maxResults);
      const result = await this.cachedCall<RawSearchPage>({
        operation,
        params: parameters,
        requestSummary: `${operation.replaceAll("_", " ")} from ${startAt}`,
        sourceId: source.id,
        force,
        fetcher: () => fetcher(parameters as never),
        itemCount: (value) => value.issues?.length ?? 0,
      });
      results.push(result);
      const pageIssues = result.value.issues ?? [];
      issues.push(...pageIssues);
      warnings.push(...(result.value.warningMessages ?? []));
      if (result.source === "LIVE")
        await this.storeSummaries(result.entryId, pageIssues, result.fetchedAt);
      total = result.value.total ?? issues.length;
      if (pageIssues.length === 0) break;
      startAt += pageIssues.length;
    }
    if (issues.length + alreadyLoaded >= MAX_ISSUES && startAt < total)
      truncated = true;
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
    if (issues.length === 0) return;
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
      await transaction.jiraCacheEntryIssue.createMany({
        data: [
          ...new Set(issues.map((issue) => issue.key).filter(Boolean)),
        ].map((issueKey) => ({ cacheEntryId: entryId, issueKey: issueKey! })),
      });
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
    const sprintNames = asArray(fields.sprint)
      .concat(asArray(fields.closedSprints))
      .map(asRecord)
      .map((sprint) => asString(sprint.name))
      .filter((name): name is string => Boolean(name));
    const comments: JiraCommentView[] = rawComments
      .map(asRecord)
      .map((comment) => ({
        id: asString(comment.id) ?? randomUUID(),
        author: person(comment.author),
        body: comment.body ?? null,
        createdAt: asString(comment.created),
        updatedAt: asString(comment.updated),
      }));
    return {
      ...summary,
      jiraUrl: `${siteUrl}/browse/${summary.key}`,
      description: fields.description ?? null,
      reporter: person(fields.reporter),
      creator: person(fields.creator),
      labels: asArray(fields.labels).filter(
        (label): label is string => typeof label === "string",
      ),
      components: namedValues(fields.components),
      fixVersions: namedValues(fields.fixVersions),
      affectedVersions: namedValues(fields.versions),
      sprintNames: [...new Set(sprintNames)],
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
