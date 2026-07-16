import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  parseCodebaseWorktreeReport,
  parseWorktreeActivityReport,
  parseWorktreeInventoryItem,
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_OPERATIONS,
  WORKTREE_WATCH_JOB_KIND,
  type CodebaseWorktreeReport,
  type WorktreeActivityReport,
  type WorktreeEditorVariant,
  type WorktreeOperation,
} from "@ai-development-environment/agent-contract/worktrees";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  AGENT_ONLINE_WINDOW_MS,
  AgentControlService,
  agentEventBus,
  agentJobChangedTopic,
  WORKTREE_CHANGED_TOPIC,
  worktreeInspectionTopic,
} from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";

const SETTINGS_ID = "default";
const ACTIVE_STATUSES = ["QUEUED", "RUNNING"];
const MISSING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const INTERACTIVE_TIMEOUT_MS = 30_000;
export const WORKTREE_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "violet",
  "pink",
] as const;

const worktreeInclude = {
  codebase: {
    include: {
      agent: true,
      repository: true,
      jobs: {
        where: { status: { in: ACTIVE_STATUSES } },
        orderBy: { createdAt: "desc" as const },
        take: 1,
      },
    },
  },
  tags: { include: { tag: true } },
} as const;

type WorktreeRecord = Prisma.WorktreeGetPayload<{
  include: typeof worktreeInclude;
}>;
type WorktreePayloadSource = {
  id: string;
  codebaseId: string;
  folder: string;
  gitDirectory: string;
  baseBranchOverride: string | null;
  codebase: {
    defaultBranch: string | null;
    repository: { canonicalOrigin: string };
  };
};
type WorktreeWatchPayload = {
  codebaseId: string;
  folder: string;
  gitDirectory: string;
  expectedOrigin: string;
  baseBranch: string | null;
};
type WorktreeWatchDemand = {
  subscribers: number;
  watchId: string;
  agentId: string;
  worktreeId: string;
  codebaseId: string;
  payload: WorktreeWatchPayload;
  started: Promise<void>;
};

function online(agent: {
  lastSeenAt: Date | null;
  disconnectedAt: Date | null;
}): boolean {
  return (
    agent.lastSeenAt !== null &&
    Date.now() - agent.lastSeenAt.getTime() <= AGENT_ONLINE_WINDOW_MS &&
    agent.disconnectedAt === null
  );
}

function capabilities(agent: { capabilitiesJson: string }): string[] {
  try {
    const value: unknown = JSON.parse(agent.capabilitiesJson);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseBranches(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function ticketKey(branch: string | null, pattern: string): string | null {
  if (!branch || !pattern) return null;
  try {
    const match = new RegExp(pattern, "i").exec(branch);
    const key = (match?.[1] ?? match?.[0])?.trim();
    return key ? key.toUpperCase() : null;
  } catch {
    return null;
  }
}

function windowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function worktreeDisplayPath(
  folder: string,
  baseRepoDirectory: string | null,
): string {
  if (!baseRepoDirectory) return folder;
  const usesWindowsPaths = windowsPath(baseRepoDirectory);
  if (usesWindowsPaths !== windowsPath(folder)) return folder;
  const path = usesWindowsPaths ? win32 : posix;
  const relativePath = path.relative(baseRepoDirectory, folder);
  if (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return folder;
  }
  return relativePath || ".";
}

function resultObject(job: {
  status: string;
  resultJson: string | null;
  error: string | null;
}) {
  if (job.status !== "SUCCEEDED" || !job.resultJson) {
    throw new Error(job.error || "Worktree job failed");
  }
  const value: unknown = JSON.parse(job.resultJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worktree job returned an invalid result");
  }
  return value as Record<string, unknown>;
}

export class WorktreesService {
  private readonly pullRequestCache = new Map<
    string,
    {
      expiresAt: number;
      items: Awaited<ReturnType<GitHubService["pullRequestsForOrigin"]>>;
    }
  >();
  private readonly watchDemand = new Map<string, WorktreeWatchDemand>();

  constructor(
    private readonly agentControl: AgentControlService,
    private readonly jiraService: JiraService,
    private readonly gitHubService: GitHubService,
  ) {
    this.agentControl.registerCompletionHandler(
      WORKTREE_OPERATION_JOB_KIND,
      (job) => this.projectOperation(job),
    );
  }

  async settings() {
    const prisma = await getPrismaClient();
    return prisma.worktreeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, editorVariant: "CODE" },
      update: {},
    });
  }

  async saveSettings(editorVariant: WorktreeEditorVariant) {
    if (!["CODE", "CODE_INSIDERS", "NONE"].includes(editorVariant)) {
      throw new Error("Unknown editor setting");
    }
    const prisma = await getPrismaClient();
    const settings = await prisma.worktreeSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, editorVariant },
      update: { editorVariant },
    });
    this.publish(null, null);
    return settings;
  }

  async requestRefresh() {
    const prisma = await getPrismaClient();
    const codebases = await prisma.codebase.findMany({
      select: { agentId: true },
    });
    return this.agentControl.requestCodebaseReconcile(
      codebases.map((codebase) => codebase.agentId),
    );
  }

  private async cleanupExpired() {
    const prisma = await getPrismaClient();
    await prisma.worktree.deleteMany({
      where: {
        missingAt: { lt: new Date(Date.now() - MISSING_RETENTION_MS) },
      },
    });
  }

  private view(worktree: WorktreeRecord, defaultRegex = "") {
    const pattern =
      worktree.codebase.repository.jiraBranchRegex ?? defaultRegex;
    return {
      ...worktree,
      relativePath: worktreeDisplayPath(
        worktree.folder,
        worktree.codebase.agent.baseRepoDirectory,
      ),
      tags: worktree.tags.map((assignment) => assignment.tag),
      activeJob:
        worktree.codebase.jobs.find(
          (job: { worktreeId: string | null }) =>
            job.worktreeId === worktree.id,
        ) ??
        worktree.codebase.jobs[0] ??
        null,
      baseBranch:
        worktree.baseBranchOverride ?? worktree.codebase.defaultBranch ?? null,
      ticketKey: ticketKey(worktree.branch, String(pattern)),
      ticketTitle: null as string | null,
      pullRequest: null as
        | Awaited<ReturnType<GitHubService["pullRequestsForOrigin"]>>[number]
        | null,
    };
  }

  async overview() {
    await this.cleanupExpired();
    const prisma = await getPrismaClient();
    const [worktrees, tags, settings, codebaseSettings, hiddenCount] =
      await Promise.all([
        prisma.worktree.findMany({
          where: { missingAt: null },
          include: worktreeInclude,
          orderBy: [
            { codebase: { agent: { name: "asc" } } },
            { codebase: { repository: { name: "asc" } } },
            { primary: "desc" },
            { branch: "asc" },
            { folder: "asc" },
          ],
        }),
        prisma.worktreeTag.findMany({ orderBy: { name: "asc" } }),
        this.settings(),
        prisma.codebaseSettings.findUnique({ where: { id: "default" } }),
        prisma.worktree.count({ where: { missingAt: { not: null } } }),
      ]);
    const defaultRegex = codebaseSettings?.defaultJiraBranchRegex ?? "";
    const views = worktrees.map((worktree) =>
      this.view(worktree, defaultRegex),
    );

    const origins = [
      ...new Set(views.map((item) => item.codebase.repository.canonicalOrigin)),
    ];
    const pullRequestsByOrigin = new Map<
      string,
      Awaited<ReturnType<GitHubService["pullRequestsForOrigin"]>>
    >();
    await Promise.all(
      origins.map(async (origin) => {
        const cached = this.pullRequestCache.get(origin);
        if (cached && cached.expiresAt > Date.now()) {
          pullRequestsByOrigin.set(origin, cached.items);
          return;
        }
        try {
          const items = await this.gitHubService.pullRequestsForOrigin(origin);
          this.pullRequestCache.set(origin, {
            items,
            expiresAt: Date.now() + 60_000,
          });
          pullRequestsByOrigin.set(origin, items);
        } catch {
          pullRequestsByOrigin.set(origin, []);
        }
      }),
    );
    const keys = [
      ...new Set(views.map((item) => item.ticketKey).filter(Boolean)),
    ] as string[];
    const titles = new Map<string, string>();
    await Promise.all(
      keys.map(async (key) => {
        try {
          const cached = await this.jiraService.cachedTicket(key);
          titles.set(
            key,
            cached?.summary ?? (await this.jiraService.ticket(key)).summary,
          );
        } catch {
          // Jira is optional on this page.
        }
      }),
    );
    for (const item of views) {
      item.ticketTitle = item.ticketKey
        ? (titles.get(item.ticketKey) ?? null)
        : null;
      item.pullRequest =
        pullRequestsByOrigin
          .get(item.codebase.repository.canonicalOrigin)
          ?.find((pullRequest) => pullRequest.headRefName === item.branch) ??
        null;
    }

    type View = (typeof views)[number];
    type CodebaseGroup = {
      codebase: View["codebase"];
      repository: View["codebase"]["repository"];
      worktrees: View[];
    };
    type AgentGroup = {
      agent: View["codebase"]["agent"];
      codebases: CodebaseGroup[];
      codebaseMap: Map<string, CodebaseGroup>;
    };
    const agentGroups = new Map<string, AgentGroup>();
    for (const worktree of views) {
      const agent = worktree.codebase.agent;
      let agentGroup = agentGroups.get(agent.id);
      if (!agentGroup) {
        agentGroup = { agent, codebases: [], codebaseMap: new Map() };
        agentGroups.set(agent.id, agentGroup);
      }
      let codebaseGroup = agentGroup.codebaseMap.get(worktree.codebase.id);
      if (!codebaseGroup) {
        codebaseGroup = {
          codebase: worktree.codebase,
          repository: worktree.codebase.repository,
          worktrees: [],
        };
        agentGroup.codebaseMap.set(worktree.codebase.id, codebaseGroup);
        agentGroup.codebases.push(codebaseGroup);
      }
      codebaseGroup.worktrees.push(worktree);
    }
    return {
      agents: [...agentGroups.values()].map((group) => ({
        agent: group.agent,
        codebases: group.codebases,
      })),
      tags,
      settings,
      hiddenCount,
    };
  }

  async hidden() {
    await this.cleanupExpired();
    const prisma = await getPrismaClient();
    const settings = await prisma.codebaseSettings.findUnique({
      where: { id: "default" },
    });
    const worktrees = await prisma.worktree.findMany({
      where: { missingAt: { not: null } },
      include: worktreeInclude,
      orderBy: { missingAt: "desc" },
    });
    return worktrees.map((worktree) =>
      this.view(worktree, settings?.defaultJiraBranchRegex ?? ""),
    );
  }

  async report(agentId: string, values: CodebaseWorktreeReport[]) {
    const prisma = await getPrismaClient();
    const updatedIds: string[] = [];
    for (const value of values.slice(0, 100)) {
      const report = parseCodebaseWorktreeReport(value);
      const codebase = await prisma.codebase.findUnique({
        where: { id: report.codebaseId },
      });
      if (!codebase || codebase.agentId !== agentId) {
        throw new Error("Codebase not found for this agent");
      }
      await prisma.$transaction(async (transaction) => {
        await transaction.codebase.update({
          where: { id: codebase.id },
          data: {
            defaultBranch: report.defaultBranch,
            remoteBranchesJson: JSON.stringify(report.remoteBranches),
            ...(report.fetchedAt
              ? { lastFetchedAt: new Date(report.fetchedAt) }
              : {}),
            ...(report.fetchAttemptedAt
              ? { lastFetchAttemptAt: new Date(report.fetchAttemptedAt) }
              : {}),
            lastFetchError: report.fetchError,
          },
        });
        const identities: string[] = [];
        for (const rawItem of report.worktrees.slice(0, 1_000)) {
          const item = parseWorktreeInventoryItem(rawItem);
          identities.push(item.gitDirectory);
          const worktree = await transaction.worktree.upsert({
            where: {
              codebaseId_gitDirectory: {
                codebaseId: codebase.id,
                gitDirectory: item.gitDirectory,
              },
            },
            create: {
              id: randomUUID(),
              codebaseId: codebase.id,
              gitDirectory: item.gitDirectory,
              ...this.inventoryData(item),
            },
            update: { ...this.inventoryData(item), missingAt: null },
          });
          updatedIds.push(worktree.id);
        }
        if (report.complete) {
          await transaction.worktree.updateMany({
            where: {
              codebaseId: codebase.id,
              missingAt: null,
              ...(identities.length
                ? { gitDirectory: { notIn: identities } }
                : {}),
            },
            data: { missingAt: new Date() },
          });
        }
      });
      this.publish(null, codebase.id);
    }
    await this.cleanupExpired();
    return prisma.worktree.findMany({
      where: { id: { in: updatedIds } },
      include: worktreeInclude,
    });
  }

  async reportActivity(agentId: string, value: WorktreeActivityReport) {
    const report = parseWorktreeActivityReport(value);
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findFirst({
      where: {
        codebaseId: report.codebaseId,
        gitDirectory: report.gitDirectory,
        missingAt: null,
        codebase: { agentId },
      },
      select: { id: true },
    });
    if (!worktree) throw new Error("Worktree activity source was not found");
    const activity = {
      worktreeId: worktree.id,
      observedAt: report.observedAt,
    };
    if (this.watchDemand.has(worktree.id)) {
      agentEventBus.publish(worktreeInspectionTopic(worktree.id), {
        worktreeInspectionChanged: activity,
      });
    }
    return activity;
  }

  private inventoryData(item: ReturnType<typeof parseWorktreeInventoryItem>) {
    return {
      folder: item.folder,
      relativePath: item.relativePath,
      primary: item.primary,
      branch: item.branch,
      headSha: item.headSha,
      upstream: item.upstream,
      ahead: item.ahead,
      behind: item.behind,
      syncState: item.syncState,
      baseAhead: item.baseAhead,
      baseBehind: item.baseBehind,
      availability: item.availability,
      statusError: item.error,
      lastCheckedAt: new Date(item.checkedAt),
    };
  }

  async updateBaseBranch(id: string, branchValue: string | null) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id },
      include: { codebase: true },
    });
    if (!worktree || worktree.missingAt) throw new Error("Worktree not found");
    const branch = branchValue?.trim() || null;
    if (
      branch &&
      !parseBranches(worktree.codebase.remoteBranchesJson).includes(branch)
    ) {
      throw new Error(
        "The selected origin branch is unavailable; fetch and try again",
      );
    }
    const updated = await prisma.worktree.update({
      where: { id },
      data: { baseBranchOverride: branch },
      include: worktreeInclude,
    });
    this.publish(id, worktree.codebaseId);
    return this.view(updated);
  }

  private requireColor(color: string | null): string | null {
    if (color === null || color === "") return null;
    if (!(WORKTREE_COLORS as readonly string[]).includes(color)) {
      throw new Error("Unknown worktree color");
    }
    return color;
  }

  async updateHighlight(id: string, colorValue: string | null) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.update({
      where: { id },
      data: { highlightColor: this.requireColor(colorValue) },
      include: worktreeInclude,
    });
    this.publish(id, worktree.codebaseId);
    return this.view(worktree);
  }

  async setTags(id: string, tagIds: string[]) {
    const prisma = await getPrismaClient();
    const unique = [...new Set(tagIds)].slice(0, 100);
    const count = await prisma.worktreeTag.count({
      where: { id: { in: unique } },
    });
    if (count !== unique.length)
      throw new Error("One or more tags were not found");
    await prisma.$transaction([
      prisma.worktreeTagAssignment.deleteMany({ where: { worktreeId: id } }),
      ...(unique.length
        ? [
            prisma.worktreeTagAssignment.createMany({
              data: unique.map((tagId) => ({ worktreeId: id, tagId })),
            }),
          ]
        : []),
    ]);
    const worktree = await prisma.worktree.findUniqueOrThrow({
      where: { id },
      include: worktreeInclude,
    });
    this.publish(id, worktree.codebaseId);
    return this.view(worktree);
  }

  async saveTag(input: { id?: string | null; name: string; color: string }) {
    const name = input.name.trim();
    if (!name || name.length > 40)
      throw new Error("Tag names must contain 1–40 characters");
    const color = this.requireColor(input.color)!;
    const prisma = await getPrismaClient();
    const tags = await prisma.worktreeTag.findMany();
    const caseInsensitiveDuplicate = tags.find(
      (tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (caseInsensitiveDuplicate && caseInsensitiveDuplicate.id !== input.id) {
      throw new Error("Tag names must be unique");
    }
    const tag = input.id
      ? await prisma.worktreeTag.update({
          where: { id: input.id },
          data: { name, color },
        })
      : await prisma.worktreeTag.create({
          data: { id: randomUUID(), name, color },
        });
    this.publish(null, null);
    return tag;
  }

  async deleteTag(id: string) {
    const prisma = await getPrismaClient();
    const deleted = await prisma.worktreeTag.deleteMany({ where: { id } });
    if (deleted.count) this.publish(null, null);
    return deleted.count > 0;
  }

  async inspect(id: string, requestId: string) {
    const worktree = await this.requireRunnable(id, WORKTREE_INSPECT_JOB_KIND);
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: WORKTREE_INSPECT_JOB_KIND,
      payload: this.payload(worktree),
      idempotencyKey: `worktree:inspect:${requestId}:${id}`,
      timeoutSeconds: 30,
      visibility: "SYSTEM",
    });
    const completed = await this.waitForJob(job.id);
    const detail = resultObject(completed).detail;
    if (!detail || typeof detail !== "object")
      throw new Error("Invalid worktree detail");
    const prisma = await getPrismaClient();
    await prisma.agentJob.deleteMany({
      where: { id: job.id, visibility: "SYSTEM" },
    });
    return detail;
  }

  async runOperation(
    id: string,
    operation: WorktreeOperation,
    requestId: string,
  ) {
    if (!WORKTREE_OPERATIONS.includes(operation))
      throw new Error("Unknown worktree operation");
    const worktree = await this.requireRunnable(
      id,
      WORKTREE_OPERATION_JOB_KIND,
    );
    const settings = await this.settings();
    return this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: WORKTREE_OPERATION_JOB_KIND,
      payload: {
        ...this.payload(worktree),
        operation,
        ...(operation === "OPEN_EDITOR"
          ? { editorVariant: settings.editorVariant }
          : {}),
      },
      idempotencyKey: `worktree:operation:${requestId}:${id}`,
      timeoutSeconds: operation === "OPEN_EDITOR" ? 30 : 600,
    });
  }

  private payload(worktree: WorktreePayloadSource) {
    return {
      codebaseId: worktree.codebaseId,
      folder: worktree.folder,
      gitDirectory: worktree.gitDirectory,
      expectedOrigin: worktree.codebase.repository.canonicalOrigin,
      baseBranch:
        worktree.baseBranchOverride ?? worktree.codebase.defaultBranch ?? null,
    };
  }

  private async requireRunnable(
    id: string,
    capability: string,
    allowBusy = false,
  ) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id },
      include: {
        codebase: { include: { agent: true, repository: true } },
      },
    });
    if (
      !worktree ||
      worktree.missingAt ||
      worktree.availability !== "AVAILABLE"
    ) {
      throw new Error("Worktree is unavailable");
    }
    if (!online(worktree.codebase.agent)) throw new Error("Agent is offline");
    if (!capabilities(worktree.codebase.agent).includes(capability)) {
      throw new Error("Agent must be updated to use worktrees");
    }
    if (!allowBusy) {
      const active = await prisma.agentJob.findFirst({
        where: {
          codebaseId: worktree.codebaseId,
          status: { in: ACTIVE_STATUSES },
        },
      });
      if (active)
        throw new Error("Another operation is active for this codebase");
    }
    return worktree;
  }

  async purge(id: string) {
    const prisma = await getPrismaClient();
    const removed = await prisma.worktree.deleteMany({
      where: { id, missingAt: { not: null } },
    });
    if (removed.count) this.publish(id, null);
    return removed.count > 0;
  }

  async purgeAll() {
    const prisma = await getPrismaClient();
    const removed = await prisma.worktree.deleteMany({
      where: { missingAt: { not: null } },
    });
    if (removed.count) this.publish(null, null);
    return removed.count;
  }

  subscribe() {
    return agentEventBus.iterate(WORKTREE_CHANGED_TOPIC);
  }

  async *subscribeInspection(worktreeId: string) {
    const events = agentEventBus.iterate<{
      worktreeInspectionChanged: {
        worktreeId: string;
        observedAt: string;
      };
    }>(worktreeInspectionTopic(worktreeId));
    let acquired = false;
    try {
      await this.acquireWatch(worktreeId);
      acquired = true;
      for await (const event of events) yield event;
    } finally {
      await events.return?.();
      if (acquired) await this.releaseWatch(worktreeId);
    }
  }

  private async acquireWatch(worktreeId: string) {
    const current = this.watchDemand.get(worktreeId);
    if (current) {
      current.subscribers += 1;
      await current.started;
      return;
    }
    const worktree = await this.requireRunnable(
      worktreeId,
      WORKTREE_WATCH_JOB_KIND,
      true,
    );
    const watchId = randomUUID();
    const payload = this.payload(worktree);
    const demand = {
      subscribers: 1,
      watchId,
      agentId: worktree.codebase.agentId,
      worktreeId: worktree.id,
      codebaseId: worktree.codebaseId,
      payload,
      started: Promise.resolve(),
    } satisfies WorktreeWatchDemand;
    demand.started = this.runWatchAction(demand, "START");
    this.watchDemand.set(worktreeId, demand);
    try {
      await demand.started;
    } catch (error) {
      if (this.watchDemand.get(worktreeId) === demand) {
        this.watchDemand.delete(worktreeId);
      }
      throw error;
    }
  }

  private async releaseWatch(worktreeId: string) {
    const demand = this.watchDemand.get(worktreeId);
    if (!demand) return;
    demand.subscribers -= 1;
    if (demand.subscribers > 0) return;
    this.watchDemand.delete(worktreeId);
    try {
      await demand.started;
      await this.runWatchAction(demand, "STOP");
    } catch (error) {
      console.error(
        "Could not stop worktree watcher:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async runWatchAction(
    demand: WorktreeWatchDemand,
    action: "START" | "STOP",
  ) {
    const job = await this.agentControl.createJob({
      agentId: demand.agentId,
      codebaseId: demand.codebaseId,
      worktreeId: demand.worktreeId,
      kind: WORKTREE_WATCH_JOB_KIND,
      payload: { ...demand.payload, action, watchId: demand.watchId },
      idempotencyKey: `worktree:watch:${action}:${demand.watchId}`,
      timeoutSeconds: 30,
      visibility: "SYSTEM",
    });
    try {
      resultObject(await this.waitForJob(job.id));
    } finally {
      const prisma = await getPrismaClient();
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  private publish(worktreeId: string | null, codebaseId: string | null) {
    agentEventBus.publish(WORKTREE_CHANGED_TOPIC, {
      worktreeOverviewChanged: { worktreeId, codebaseId },
    });
  }

  private async projectOperation(job: {
    worktreeId: string | null;
    resultJson: string | null;
    status: string;
  }) {
    if (!job.worktreeId || job.status !== "SUCCEEDED" || !job.resultJson)
      return;
    const result = resultObject({ ...job, error: null });
    if (!result.worktree) return;
    const item = parseWorktreeInventoryItem(result.worktree);
    const prisma = await getPrismaClient();
    const current = await prisma.worktree.findUnique({
      where: { id: job.worktreeId },
    });
    if (!current) return;
    await prisma.worktree.update({
      where: { id: current.id },
      data: {
        branch: item.branch,
        headSha: item.headSha,
        upstream: item.upstream,
        ahead: item.ahead,
        behind: item.behind,
        syncState: item.syncState,
        baseAhead: item.baseAhead,
        baseBehind: item.baseBehind,
        availability: item.availability,
        statusError: item.error,
        lastCheckedAt: new Date(item.checkedAt),
      },
    });
    this.publish(current.id, current.codebaseId);
  }

  private async waitForJob(jobId: string) {
    const events = agentEventBus.iterate(agentJobChangedTopic(jobId));
    const deadline = Date.now() + INTERACTIVE_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const job = await this.agentControl.getJob(jobId);
        if (!job) throw new Error("Worktree job disappeared");
        if (
          ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)
        ) {
          return job;
        }
        await Promise.race([
          events.next(),
          new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
        ]);
      }
      await this.agentControl.cancelJob(jobId);
      throw new Error("Agent did not respond in time");
    } finally {
      await events.return?.();
    }
  }
}
