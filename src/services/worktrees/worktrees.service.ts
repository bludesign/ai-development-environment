import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  parseCodebaseWorktreeReport,
  parseWorktreeActivityReport,
  parseWorktreeInventoryItem,
  validGitBranchName,
  WORKTREE_BRANCH_JOB_KIND,
  WORKTREE_DELETE_JOB_KIND,
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_MOVE_CHECKOUT_JOB_KIND,
  WORKTREE_MOVE_PUSH_JOB_KIND,
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
import { jiraBranchCandidates } from "@/services/jira";
import type { SkillsService } from "@/services/skills";
import { buildOutOfDate } from "@/services/builds/build-freshness";

const SETTINGS_ID = "default";
const ACTIVE_STATUSES = ["QUEUED", "RUNNING"];
const ACTIVE_BUILD_STATUSES = ["QUEUED", "PREPARING", "RUNNING"];
const ACTIVE_MOVE_STATUSES = [
  "PUSHING",
  "CHECKING_OUT",
  "AWAITING_STASH",
  "CLEANING_UP",
];
const MISSING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const INTERACTIVE_TIMEOUT_MS = 30_000;
export const WORKTREE_COLORS = [
  "gray",
  "stone",
  "red",
  "rose",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
] as const;

const worktreeInclude = {
  codebase: {
    include: {
      agent: true,
      repository: {
        include: {
          projects: {
            where: { type: "IOS_APP" },
            include: { configurations: { select: { id: true } } },
          },
        },
      },
      jobs: {
        where: { status: { in: ACTIVE_STATUSES } },
        orderBy: { createdAt: "desc" as const },
        take: 1,
      },
    },
  },
  tags: { include: { tag: true } },
  builds: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      id: true,
      status: true,
      action: true,
      destinationType: true,
      destinationJson: true,
      snapshotJson: true,
      createdAt: true,
      finishedAt: true,
      artifacts: { select: { id: true, kind: true } },
    },
  },
  _count: {
    select: {
      builds: { where: { status: { in: ACTIVE_BUILD_STATUSES } } },
    },
  },
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

export type WorktreeBranchSelection = {
  mode: "NEW" | "EXISTING" | "TICKET";
  branchName?: string | null;
  ticketKey?: string | null;
  baseBranch: string;
};

type RunnableCodebase = Prisma.CodebaseGetPayload<{
  include: { agent: true; repository: true };
}>;

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
    private readonly skillsService?: SkillsService,
  ) {
    this.agentControl.registerCompletionHandler(
      WORKTREE_OPERATION_JOB_KIND,
      (job) => this.projectOperation(job),
    );
    this.agentControl.registerCompletionHandler(
      WORKTREE_BRANCH_JOB_KIND,
      (job) => this.projectBranchOperation(job),
    );
    this.agentControl.registerCompletionHandler(
      WORKTREE_MOVE_PUSH_JOB_KIND,
      (job) => this.advanceMoveAfterPush(job),
    );
    this.agentControl.registerCompletionHandler(
      WORKTREE_MOVE_CHECKOUT_JOB_KIND,
      (job) => this.advanceMoveAfterCheckout(job),
    );
    this.agentControl.registerCompletionHandler(
      WORKTREE_DELETE_JOB_KIND,
      (job) => this.projectDeleteOperation(job),
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

  invalidatePullRequestsForOrigin(canonicalOrigin: string): void {
    const normalizedOrigin = canonicalOrigin.toLowerCase();
    for (const origin of this.pullRequestCache.keys()) {
      if (origin.toLowerCase() === normalizedOrigin) {
        this.pullRequestCache.delete(origin);
      }
    }
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
      ticketStatus: null as string | null,
      pullRequest: null as
        | Awaited<ReturnType<GitHubService["pullRequestsForOrigin"]>>[number]
        | null,
      latestBuild: worktree.builds?.[0]
        ? {
            ...worktree.builds[0],
            outOfDate: buildOutOfDate({
              ...worktree.builds[0],
              worktree,
            }),
          }
        : null,
    };
  }

  async overview() {
    await this.cleanupExpired();
    const prisma = await getPrismaClient();
    const [
      worktrees,
      tags,
      settings,
      codebaseSettings,
      hiddenCount,
      activeMoves,
    ] = await Promise.all([
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
      prisma.worktreeMove.findMany({
        where: { status: { in: ACTIVE_MOVE_STATUSES } },
        orderBy: { createdAt: "asc" },
      }),
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
    const tickets = new Map<string, { title: string; status: string | null }>();
    await Promise.all(
      keys.map(async (key) => {
        try {
          const cached = await this.jiraService.cachedTicket(key);
          const ticket = cached ?? (await this.jiraService.ticket(key));
          tickets.set(key, {
            title: ticket.summary,
            status: ticket.status,
          });
        } catch {
          // Jira is optional on this page.
        }
      }),
    );
    for (const item of views) {
      item.ticketTitle = item.ticketKey
        ? (tickets.get(item.ticketKey)?.title ?? null)
        : null;
      item.ticketStatus = item.ticketKey
        ? (tickets.get(item.ticketKey)?.status ?? null)
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
      iosBuildConfigured: boolean;
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
          iosBuildConfigured:
            worktree.codebase.repository.projects?.some(
              (project) => project.configurations.length > 0,
            ) ?? false,
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
      activeMoves,
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
    let deploymentTargetsChanged = false;
    for (const value of values.slice(0, 100)) {
      const report = parseCodebaseWorktreeReport(value);
      const codebase = await prisma.codebase.findUnique({
        where: { id: report.codebaseId },
      });
      if (!codebase || codebase.agentId !== agentId) {
        throw new Error("Codebase not found for this agent");
      }
      const inventory = report.worktrees
        .slice(0, 1_000)
        .map((item) => parseWorktreeInventoryItem(item));
      const previous = await prisma.worktree.findMany({
        where: { codebaseId: codebase.id },
        select: { gitDirectory: true, folder: true, missingAt: true },
      });
      const previousByGitDirectory = new Map(
        previous.map((item) => [item.gitDirectory, item]),
      );
      const reportedGitDirectories = new Set(
        inventory.map((item) => item.gitDirectory),
      );
      deploymentTargetsChanged ||=
        inventory.some((item) => {
          const known = previousByGitDirectory.get(item.gitDirectory);
          return (
            !known || known.folder !== item.folder || known.missingAt !== null
          );
        }) ||
        (report.complete &&
          previous.some(
            (item) =>
              item.missingAt === null &&
              !reportedGitDirectories.has(item.gitDirectory),
          ));
      await prisma.$transaction(async (transaction) => {
        await transaction.codebase.update({
          where: { id: codebase.id },
          data: {
            defaultBranch: report.defaultBranch,
            localBranchesJson: JSON.stringify(report.localBranches),
            remoteBranchesJson: JSON.stringify(report.remoteBranches),
            ...(report.fetchedAt
              ? { lastFetchedAt: new Date(report.fetchedAt) }
              : {}),
            ...(report.fetchAttemptedAt
              ? {
                  lastFetchAttemptAt: new Date(report.fetchAttemptedAt),
                  lastFetchError: report.fetchError,
                }
              : report.fetchError
                ? { lastFetchError: report.fetchError }
                : {}),
          },
        });
        const identities: string[] = [];
        for (const item of inventory) {
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
            update: {},
          });
          await transaction.worktree.updateMany({
            where: {
              id: worktree.id,
              OR: [
                { lastCheckedAt: null },
                { lastCheckedAt: { lt: new Date(item.checkedAt) } },
              ],
            },
            data: { ...this.inventoryData(item), missingAt: null },
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
    if (deploymentTargetsChanged) {
      await this.skillsService?.requestAutoReconcile();
    }
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
      select: { id: true, codebaseId: true },
    });
    if (!worktree) throw new Error("Worktree activity source was not found");
    const hasCommitStatus =
      report.branch !== undefined ||
      report.headSha !== undefined ||
      report.upstream !== undefined ||
      report.ahead !== undefined ||
      report.behind !== undefined ||
      report.syncState !== undefined ||
      report.baseAhead !== undefined ||
      report.baseBehind !== undefined;
    let observationAccepted = true;
    const hasState =
      hasCommitStatus ||
      report.hasStagedChanges !== undefined ||
      report.hasUnstagedChanges !== undefined ||
      report.codeStateHash !== undefined ||
      report.pushStatus !== undefined;
    if (hasState) {
      const updated = await prisma.worktree.updateMany({
        where: {
          id: worktree.id,
          OR: [
            { lastCheckedAt: null },
            { lastCheckedAt: { lt: new Date(report.observedAt) } },
          ],
        },
        data: {
          ...(report.branch === undefined ? {} : { branch: report.branch }),
          ...(report.headSha === undefined ? {} : { headSha: report.headSha }),
          ...(report.upstream === undefined
            ? {}
            : { upstream: report.upstream }),
          ...(report.ahead === undefined ? {} : { ahead: report.ahead }),
          ...(report.behind === undefined ? {} : { behind: report.behind }),
          ...(report.syncState === undefined
            ? {}
            : { syncState: report.syncState }),
          ...(report.baseAhead === undefined
            ? {}
            : { baseAhead: report.baseAhead }),
          ...(report.baseBehind === undefined
            ? {}
            : { baseBehind: report.baseBehind }),
          lastCheckedAt: new Date(report.observedAt),
          ...(report.hasStagedChanges === undefined
            ? {}
            : { hasStagedChanges: report.hasStagedChanges }),
          ...(report.hasUnstagedChanges === undefined
            ? {}
            : { hasUnstagedChanges: report.hasUnstagedChanges }),
          ...(report.codeStateHash === undefined
            ? {}
            : { codeStateHash: report.codeStateHash }),
          ...(report.pushStatus === undefined
            ? {}
            : { pushStatus: report.pushStatus }),
        },
      });
      observationAccepted = updated.count > 0;
      if (observationAccepted) {
        this.publish(worktree.id, worktree.codebaseId);
      }
    }
    const activity = {
      worktreeId: worktree.id,
      ...(report.branch === undefined ? {} : { branch: report.branch }),
      ...(report.headSha === undefined ? {} : { headSha: report.headSha }),
      ...(report.upstream === undefined ? {} : { upstream: report.upstream }),
      ...(report.ahead === undefined ? {} : { ahead: report.ahead }),
      ...(report.behind === undefined ? {} : { behind: report.behind }),
      ...(report.syncState === undefined
        ? {}
        : { syncState: report.syncState }),
      ...(report.baseAhead === undefined
        ? {}
        : { baseAhead: report.baseAhead }),
      ...(report.baseBehind === undefined
        ? {}
        : { baseBehind: report.baseBehind }),
      ...(report.hasStagedChanges === undefined
        ? {}
        : { hasStagedChanges: report.hasStagedChanges }),
      ...(report.hasUnstagedChanges === undefined
        ? {}
        : { hasUnstagedChanges: report.hasUnstagedChanges }),
      ...(report.pushStatus === undefined
        ? {}
        : { pushStatus: report.pushStatus }),
      observedAt: report.observedAt,
    };
    if (this.watchDemand.has(worktree.id) && observationAccepted) {
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
      codeStateHash: item.codeStateHash ?? null,
      upstream: item.upstream,
      ahead: item.ahead,
      behind: item.behind,
      syncState: item.syncState,
      baseAhead: item.baseAhead,
      baseBehind: item.baseBehind,
      hasStagedChanges: item.hasStagedChanges ?? false,
      hasUnstagedChanges: item.hasUnstagedChanges ?? false,
      pushStatus: item.pushStatus ?? "UNKNOWN",
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
    await this.restartWatch(id);
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

  private async repositoryTakenBranches(repositoryId: string) {
    const prisma = await getPrismaClient();
    const codebases = await prisma.codebase.findMany({
      where: { repositoryId },
      select: {
        localBranchesJson: true,
        remoteBranchesJson: true,
        worktrees: {
          where: { missingAt: null },
          select: { branch: true },
        },
      },
    });
    return new Set(
      codebases.flatMap((codebase) => [
        ...parseBranches(codebase.localBranchesJson),
        ...parseBranches(codebase.remoteBranchesJson),
        ...codebase.worktrees.flatMap((worktree) =>
          worktree.branch ? [worktree.branch] : [],
        ),
      ]),
    );
  }

  private requireBaseBranch(codebase: RunnableCodebase, value: string) {
    const baseBranch = value.trim();
    if (
      !baseBranch ||
      !parseBranches(codebase.remoteBranchesJson).includes(baseBranch)
    ) {
      throw new Error(
        "The selected origin base branch is unavailable; fetch and try again",
      );
    }
    return baseBranch;
  }

  private async ticketBranch(
    codebase: RunnableCodebase,
    ticketKeyValue: string | null | undefined,
    currentBranch: string | null,
  ) {
    const ticketKey = ticketKeyValue?.trim() ?? "";
    const ticket = await this.jiraService.branchTicket(ticketKey);
    const candidates = await jiraBranchCandidates(ticket.branchNamingScript, {
      ticketKey: ticket.ticketKey,
      type: ticket.ticketType ?? "",
      title: ticket.ticketTitle,
    });
    const taken = await this.repositoryTakenBranches(codebase.repositoryId);
    const available = candidates.filter(
      (candidate) => candidate === currentBranch || !taken.has(candidate),
    );
    if (!available.length) {
      throw new Error("Every generated ticket branch name is already taken");
    }
    return { ticket, candidates: available };
  }

  async previewTicketBranch(input: {
    codebaseId: string;
    worktreeId?: string | null;
    ticketKey: string;
  }) {
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id: input.codebaseId },
      include: { agent: true, repository: true },
    });
    if (!codebase) throw new Error("Codebase not found");
    let currentBranch: string | null = null;
    if (input.worktreeId) {
      const worktree = await prisma.worktree.findFirst({
        where: {
          id: input.worktreeId,
          codebaseId: input.codebaseId,
          missingAt: null,
        },
        select: { branch: true },
      });
      if (!worktree) throw new Error("Worktree not found for this codebase");
      currentBranch = worktree.branch;
    }
    const { ticket, candidates } = await this.ticketBranch(
      codebase,
      input.ticketKey,
      currentBranch,
    );
    return {
      ticketKey: ticket.ticketKey,
      ticketTitle: ticket.ticketTitle,
      ticketType: ticket.ticketType,
      projectKey: ticket.projectKey,
      branchName: candidates[0]!,
    };
  }

  private async resolveBranchSelection(
    codebase: RunnableCodebase,
    selection: WorktreeBranchSelection,
    currentWorktree: { id: string; branch: string | null } | null,
  ) {
    const baseBranch = this.requireBaseBranch(codebase, selection.baseBranch);
    if (selection.mode === "TICKET") {
      const { candidates } = await this.ticketBranch(
        codebase,
        selection.ticketKey,
        currentWorktree?.branch ?? null,
      );
      return { baseBranch, mode: "NEW" as const, candidates };
    }
    const branch = selection.branchName?.trim() ?? "";
    if (!validGitBranchName(branch)) {
      throw new Error("Enter a valid Git branch name");
    }
    if (selection.mode === "NEW") {
      const taken = await this.repositoryTakenBranches(codebase.repositoryId);
      if (taken.has(branch))
        throw new Error(`Branch ${branch} is already taken`);
      return { baseBranch, mode: "NEW" as const, candidates: [branch] };
    }
    if (selection.mode !== "EXISTING") {
      throw new Error("Unknown worktree branch mode");
    }
    const exists = new Set([
      ...parseBranches(codebase.localBranchesJson),
      ...parseBranches(codebase.remoteBranchesJson),
    ]).has(branch);
    if (!exists) {
      throw new Error(
        `Existing branch ${branch} is unavailable; refresh and try again`,
      );
    }
    const prisma = await getPrismaClient();
    const checkedOutElsewhere = await prisma.worktree.findFirst({
      where: {
        codebaseId: codebase.id,
        branch,
        missingAt: null,
        ...(currentWorktree ? { id: { not: currentWorktree.id } } : {}),
      },
      select: { id: true },
    });
    if (checkedOutElsewhere) {
      throw new Error(`Branch ${branch} is checked out in another worktree`);
    }
    return { baseBranch, mode: "EXISTING" as const, candidates: [branch] };
  }

  async createWorktree(input: {
    codebaseId: string;
    selection: WorktreeBranchSelection;
    requestId: string;
  }) {
    const codebase = await this.requireRunnableCodebase(input.codebaseId);
    const resolved = await this.resolveBranchSelection(
      codebase,
      input.selection,
      null,
    );
    return this.agentControl.createJob({
      agentId: codebase.agentId,
      codebaseId: codebase.id,
      kind: WORKTREE_BRANCH_JOB_KIND,
      payload: {
        codebaseId: codebase.id,
        rootFolder: codebase.folder,
        folder: null,
        gitDirectory: null,
        expectedOrigin: codebase.repository.canonicalOrigin,
        baseBranch: resolved.baseBranch,
        action: "CREATE",
        mode: resolved.mode,
        candidates: resolved.candidates,
        stashOnFailure: false,
      },
      idempotencyKey: `worktree:branch:create:${input.requestId}:${codebase.id}`,
      timeoutSeconds: 600,
    });
  }

  async changeWorktreeBranch(input: {
    worktreeId: string;
    selection: WorktreeBranchSelection;
    requestId: string;
    stashOnFailure?: boolean | null;
  }) {
    const worktree = await this.requireRunnable(
      input.worktreeId,
      WORKTREE_BRANCH_JOB_KIND,
    );
    const resolved = await this.resolveBranchSelection(
      worktree.codebase,
      input.selection,
      { id: worktree.id, branch: worktree.branch },
    );
    return this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: WORKTREE_BRANCH_JOB_KIND,
      payload: {
        codebaseId: worktree.codebaseId,
        rootFolder: worktree.codebase.folder,
        folder: worktree.folder,
        gitDirectory: worktree.gitDirectory,
        expectedOrigin: worktree.codebase.repository.canonicalOrigin,
        baseBranch: resolved.baseBranch,
        action: "CHANGE",
        mode: resolved.mode,
        candidates: resolved.candidates,
        stashOnFailure: Boolean(input.stashOnFailure),
      },
      idempotencyKey: `worktree:branch:change:${input.requestId}:${worktree.id}`,
      timeoutSeconds: 600,
    });
  }

  async getMove(id: string) {
    const prisma = await getPrismaClient();
    return prisma.worktreeMove.findUnique({ where: { id } });
  }

  async moveWorktree(input: {
    sourceWorktreeId: string;
    targetCodebaseId: string;
    targetWorktreeId?: string | null;
    deleteSource: boolean;
    requestId: string;
  }) {
    const prisma = await getPrismaClient();
    const existing = await prisma.worktreeMove.findUnique({
      where: {
        sourceWorktreeId_requestId: {
          sourceWorktreeId: input.sourceWorktreeId,
          requestId: input.requestId,
        },
      },
    });
    if (existing) return existing;
    const source = await this.requireRunnable(
      input.sourceWorktreeId,
      WORKTREE_MOVE_PUSH_JOB_KIND,
    );
    if (!source.branch || !source.headSha) {
      throw new Error("A named source branch is required");
    }
    if (
      source.hasStagedChanges ||
      source.hasUnstagedChanges ||
      source.pushStatus !== "READY"
    ) {
      throw new Error(
        "The source branch must be clean and safely pushable before moving",
      );
    }
    if (input.deleteSource && source.primary) {
      throw new Error("The primary worktree cannot be deleted after moving");
    }
    if (
      input.deleteSource &&
      !capabilities(source.codebase.agent).includes(WORKTREE_DELETE_JOB_KIND)
    ) {
      throw new Error(
        "Source agent must be updated to remove the old worktree",
      );
    }
    const target = await this.requireRunnableCodebase(
      input.targetCodebaseId,
      WORKTREE_MOVE_CHECKOUT_JOB_KIND,
    );
    if (
      source.codebase.repositoryId !== target.repositoryId ||
      source.codebase.agentId === target.agentId
    ) {
      throw new Error(
        "The destination must be the same repository on another agent",
      );
    }
    const targetWorktree = input.targetWorktreeId
      ? await prisma.worktree.findFirst({
          where: {
            id: input.targetWorktreeId,
            codebaseId: target.id,
            missingAt: null,
            availability: "AVAILABLE",
          },
        })
      : null;
    if (input.targetWorktreeId && !targetWorktree) {
      throw new Error("Destination worktree not found");
    }
    const branchConflict = await prisma.worktree.findFirst({
      where: {
        codebaseId: target.id,
        branch: source.branch,
        missingAt: null,
        ...(targetWorktree ? { id: { not: targetWorktree.id } } : {}),
      },
      select: { id: true },
    });
    if (branchConflict) {
      throw new Error(
        "The source branch is already checked out in another destination worktree",
      );
    }
    const baseBranch = target.defaultBranch ?? source.codebase.defaultBranch;
    if (!baseBranch) {
      throw new Error("The destination default branch is unavailable");
    }
    const moveId = randomUUID();
    let move;
    try {
      move = await prisma.worktreeMove.create({
        data: {
          id: moveId,
          requestId: input.requestId,
          sourceWorktreeId: source.id,
          sourceCodebaseId: source.codebaseId,
          targetCodebaseId: target.id,
          targetWorktreeId: targetWorktree?.id ?? null,
          destinationMode: targetWorktree ? "EXISTING" : "NEW",
          branch: source.branch,
          headSha: source.headSha,
          baseBranch,
          deleteSource: input.deleteSource,
          status: "PUSHING",
        },
      });
    } catch (error) {
      const concurrent = await prisma.worktreeMove.findUnique({
        where: {
          sourceWorktreeId_requestId: {
            sourceWorktreeId: input.sourceWorktreeId,
            requestId: input.requestId,
          },
        },
      });
      if (concurrent) return concurrent;
      throw error;
    }
    try {
      const job = await this.agentControl.createJob({
        agentId: source.codebase.agentId,
        codebaseId: source.codebaseId,
        worktreeId: source.id,
        kind: WORKTREE_MOVE_PUSH_JOB_KIND,
        payload: {
          moveId: move.id,
          codebaseId: source.codebaseId,
          folder: source.folder,
          gitDirectory: source.gitDirectory,
          expectedOrigin: source.codebase.repository.canonicalOrigin,
          branch: source.branch,
          expectedHeadSha: source.headSha,
        },
        idempotencyKey: `worktree:move:push:${move.id}`,
        timeoutSeconds: 600,
      });
      move = await prisma.worktreeMove.update({
        where: { id: move.id },
        data: { sourceJobId: job.id },
      });
      this.publish(source.id, source.codebaseId);
      return move;
    } catch (error) {
      await prisma.worktreeMove.update({
        where: { id: move.id },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async retryWorktreeMoveWithStash(id: string) {
    const prisma = await getPrismaClient();
    const move = await prisma.worktreeMove.findUnique({ where: { id } });
    if (!move || move.status !== "AWAITING_STASH") {
      throw new Error("This move is not waiting for a stash decision");
    }
    const job = await this.createMoveCheckoutJob(move, true);
    const updated = await prisma.worktreeMove.updateMany({
      where: { id, status: "AWAITING_STASH" },
      data: {
        status: "CHECKING_OUT",
        targetJobId: job.id,
        error: null,
      },
    });
    if (updated.count !== 1) {
      const current = await prisma.worktreeMove.findUniqueOrThrow({
        where: { id },
      });
      if (current.status !== "AWAITING_STASH") return current;
      throw new Error("The move state changed; refresh and try again");
    }
    this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
    return prisma.worktreeMove.findUniqueOrThrow({ where: { id } });
  }

  async cancelWorktreeMove(id: string) {
    const prisma = await getPrismaClient();
    const move = await prisma.worktreeMove.findUnique({ where: { id } });
    if (!move || move.status !== "AWAITING_STASH") {
      throw new Error(
        "Only a move waiting for a stash decision can be cancelled",
      );
    }
    const updated = await prisma.worktreeMove.update({
      where: { id },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
    this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
    return updated;
  }

  async deleteWorktree(input: {
    worktreeId: string;
    deleteRemoteBranch: boolean;
    requestId: string;
  }) {
    const worktree = await this.requireRunnable(
      input.worktreeId,
      WORKTREE_DELETE_JOB_KIND,
    );
    if (worktree.primary)
      throw new Error("The primary worktree cannot be deleted");
    if (
      input.deleteRemoteBranch &&
      (!worktree.branch || worktree.branch === worktree.codebase.defaultBranch)
    ) {
      throw new Error("The default remote branch cannot be deleted");
    }
    return this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: WORKTREE_DELETE_JOB_KIND,
      payload: {
        moveId: null,
        codebaseId: worktree.codebaseId,
        rootFolder: worktree.codebase.folder,
        folder: worktree.folder,
        gitDirectory: worktree.gitDirectory,
        expectedOrigin: worktree.codebase.repository.canonicalOrigin,
        branch: worktree.branch,
        defaultBranch: worktree.codebase.defaultBranch,
        deleteRemoteBranch: input.deleteRemoteBranch,
        requireClean: false,
        expectedHeadSha: null,
      },
      idempotencyKey: `worktree:delete:${input.requestId}:${worktree.id}`,
      timeoutSeconds: 600,
    });
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
    try {
      const completed = await this.waitForJob(job.id);
      const detail = resultObject(completed).detail;
      if (!detail || typeof detail !== "object") {
        throw new Error("Invalid worktree detail");
      }
      return detail;
    } finally {
      const prisma = await getPrismaClient();
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
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
      const [active, activeMove] = await Promise.all([
        prisma.agentJob.findFirst({
          where: {
            codebaseId: worktree.codebaseId,
            status: { in: ACTIVE_STATUSES },
          },
        }),
        prisma.worktreeMove.findFirst({
          where: {
            status: { in: ACTIVE_MOVE_STATUSES },
            OR: [
              { sourceCodebaseId: worktree.codebaseId },
              { targetCodebaseId: worktree.codebaseId },
            ],
          },
        }),
      ]);
      if (active || activeMove)
        throw new Error("Another operation is active for this codebase");
    }
    return worktree;
  }

  private async requireRunnableCodebase(
    id: string,
    capability = WORKTREE_BRANCH_JOB_KIND,
  ): Promise<RunnableCodebase> {
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id },
      include: { agent: true, repository: true },
    });
    if (!codebase || codebase.availability !== "AVAILABLE") {
      throw new Error("Codebase is unavailable");
    }
    if (!online(codebase.agent)) throw new Error("Agent is offline");
    if (!capabilities(codebase.agent).includes(capability)) {
      throw new Error("Agent must be updated to create or change worktrees");
    }
    const [active, activeMove] = await Promise.all([
      prisma.agentJob.findFirst({
        where: { codebaseId: id, status: { in: ACTIVE_STATUSES } },
      }),
      prisma.worktreeMove.findFirst({
        where: {
          status: { in: ACTIVE_MOVE_STATUSES },
          OR: [{ sourceCodebaseId: id }, { targetCodebaseId: id }],
        },
      }),
    ]);
    if (active || activeMove)
      throw new Error("Another operation is active for this codebase");
    return codebase;
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
        hasStagedChanges?: boolean;
        hasUnstagedChanges?: boolean;
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

  private async restartWatch(worktreeId: string) {
    const previous = this.watchDemand.get(worktreeId);
    if (!previous) return;
    try {
      await previous.started;
      if (this.watchDemand.get(worktreeId) !== previous) return;
      await this.runWatchAction(previous, "STOP");
      if (this.watchDemand.get(worktreeId) !== previous) return;
      const worktree = await this.requireRunnable(
        worktreeId,
        WORKTREE_WATCH_JOB_KIND,
        true,
      );
      const demand = {
        subscribers: previous.subscribers,
        watchId: randomUUID(),
        agentId: worktree.codebase.agentId,
        worktreeId: worktree.id,
        codebaseId: worktree.codebaseId,
        payload: this.payload(worktree),
        started: Promise.resolve(),
      } satisfies WorktreeWatchDemand;
      demand.started = this.runWatchAction(demand, "START");
      this.watchDemand.set(worktreeId, demand);
      await demand.started;
    } catch (error) {
      console.error(
        "Could not restart worktree watcher:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private publish(worktreeId: string | null, codebaseId: string | null) {
    agentEventBus.publish(WORKTREE_CHANGED_TOPIC, {
      worktreeOverviewChanged: { worktreeId, codebaseId },
    });
  }

  private moveIdFromJob(job: { payloadJson: string }): string {
    const payload: unknown = JSON.parse(job.payloadJson);
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof (payload as Record<string, unknown>).moveId !== "string"
    ) {
      throw new Error("Move job is missing its workflow identifier");
    }
    return String((payload as Record<string, unknown>).moveId);
  }

  private async failMove(id: string, expectedStatus: string, error: string) {
    const prisma = await getPrismaClient();
    const updated = await prisma.worktreeMove.updateMany({
      where: { id, status: expectedStatus },
      data: { status: "FAILED", error, finishedAt: new Date() },
    });
    if (updated.count) this.publish(null, null);
  }

  private async createMoveCheckoutJob(
    move: {
      id: string;
      targetCodebaseId: string;
      targetWorktreeId: string | null;
      destinationMode: string;
      branch: string;
      headSha: string;
      baseBranch: string;
    },
    stashOnFailure: boolean,
  ) {
    const prisma = await getPrismaClient();
    const target = await prisma.codebase.findUnique({
      where: { id: move.targetCodebaseId },
      include: { agent: true, repository: true },
    });
    if (!target) throw new Error("Destination codebase no longer exists");
    if (!online(target.agent)) throw new Error("Destination agent is offline");
    if (!capabilities(target.agent).includes(WORKTREE_MOVE_CHECKOUT_JOB_KIND)) {
      throw new Error("Destination agent must be updated to move worktrees");
    }
    const targetWorktree = move.targetWorktreeId
      ? await prisma.worktree.findFirst({
          where: {
            id: move.targetWorktreeId,
            codebaseId: target.id,
            missingAt: null,
            availability: "AVAILABLE",
          },
        })
      : null;
    if (move.destinationMode === "EXISTING" && !targetWorktree) {
      throw new Error("Destination worktree is no longer available");
    }
    return this.agentControl.createJob({
      agentId: target.agentId,
      codebaseId: target.id,
      worktreeId: targetWorktree?.id ?? null,
      kind: WORKTREE_MOVE_CHECKOUT_JOB_KIND,
      payload: {
        moveId: move.id,
        codebaseId: target.id,
        rootFolder: target.folder,
        folder: targetWorktree?.folder ?? null,
        gitDirectory: targetWorktree?.gitDirectory ?? null,
        expectedOrigin: target.repository.canonicalOrigin,
        branch: move.branch,
        expectedHeadSha: move.headSha,
        baseBranch: move.baseBranch,
        mode: move.destinationMode,
        stashOnFailure,
      },
      idempotencyKey: `worktree:move:checkout:${move.id}:${
        stashOnFailure ? "stash" : "initial"
      }`,
      timeoutSeconds: 600,
    });
  }

  private async advanceMoveAfterPush(job: {
    id: string;
    payloadJson: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }) {
    const moveId = this.moveIdFromJob(job);
    const prisma = await getPrismaClient();
    const move = await prisma.worktreeMove.findUnique({
      where: { id: moveId },
    });
    if (
      !move ||
      move.status !== "PUSHING" ||
      (move.sourceJobId && move.sourceJobId !== job.id)
    ) {
      return;
    }
    if (job.status !== "SUCCEEDED") {
      await this.failMove(
        move.id,
        "PUSHING",
        job.error || "Could not push the source branch",
      );
      return;
    }
    const result = resultObject(job);
    if (result.headSha !== move.headSha || result.branch !== move.branch) {
      await this.failMove(
        move.id,
        "PUSHING",
        "The source push returned an unexpected branch",
      );
      return;
    }
    try {
      const checkout = await this.createMoveCheckoutJob(move, false);
      await prisma.worktreeMove.updateMany({
        where: { id: move.id, status: "PUSHING" },
        data: { status: "CHECKING_OUT", targetJobId: checkout.id },
      });
      this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
    } catch (error) {
      await this.failMove(
        move.id,
        "PUSHING",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async projectMoveDestination(
    move: {
      id: string;
      targetCodebaseId: string;
      targetWorktreeId: string | null;
      baseBranch: string;
    },
    rawWorktree: unknown,
  ) {
    const item = parseWorktreeInventoryItem(rawWorktree);
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id: move.targetCodebaseId },
      select: { localBranchesJson: true },
    });
    if (!codebase) throw new Error("Destination codebase no longer exists");
    const branches = new Set(parseBranches(codebase.localBranchesJson));
    if (item.branch) branches.add(item.branch);
    let targetWorktreeId = move.targetWorktreeId;
    await prisma.$transaction(async (transaction) => {
      await transaction.codebase.update({
        where: { id: move.targetCodebaseId },
        data: {
          localBranchesJson: JSON.stringify(
            [...branches].sort((first, second) => first.localeCompare(second)),
          ),
        },
      });
      if (targetWorktreeId) {
        const updated = await transaction.worktree.updateMany({
          where: {
            id: targetWorktreeId,
            codebaseId: move.targetCodebaseId,
          },
          data: {
            ...this.inventoryData(item),
            gitDirectory: item.gitDirectory,
            baseBranchOverride: move.baseBranch,
            missingAt: null,
          },
        });
        if (updated.count !== 1) {
          throw new Error("Destination worktree no longer exists");
        }
      } else {
        const projected = await transaction.worktree.upsert({
          where: {
            codebaseId_gitDirectory: {
              codebaseId: move.targetCodebaseId,
              gitDirectory: item.gitDirectory,
            },
          },
          create: {
            id: randomUUID(),
            codebaseId: move.targetCodebaseId,
            gitDirectory: item.gitDirectory,
            ...this.inventoryData(item),
            baseBranchOverride: move.baseBranch,
          },
          update: {
            ...this.inventoryData(item),
            baseBranchOverride: move.baseBranch,
            missingAt: null,
          },
        });
        targetWorktreeId = projected.id;
      }
      await transaction.worktreeMove.update({
        where: { id: move.id },
        data: { targetWorktreeId },
      });
    });
    this.publish(targetWorktreeId ?? null, move.targetCodebaseId);
    await this.skillsService?.requestAutoReconcile();
    return targetWorktreeId!;
  }

  private async scheduleMoveCleanup(moveId: string) {
    const prisma = await getPrismaClient();
    const move = await prisma.worktreeMove.findUniqueOrThrow({
      where: { id: moveId },
    });
    const source = await prisma.worktree.findUnique({
      where: { id: move.sourceWorktreeId },
      include: { codebase: { include: { agent: true, repository: true } } },
    });
    if (!source || source.missingAt || source.primary) {
      await prisma.worktreeMove.update({
        where: { id: move.id },
        data: {
          status: "SUCCEEDED_WITH_WARNING",
          warning:
            "Destination is ready, but the source worktree could not be removed",
          finishedAt: new Date(),
        },
      });
      this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
      return;
    }
    try {
      const cleanup = await this.agentControl.createJob({
        agentId: source.codebase.agentId,
        codebaseId: source.codebaseId,
        worktreeId: source.id,
        kind: WORKTREE_DELETE_JOB_KIND,
        payload: {
          moveId: move.id,
          codebaseId: source.codebaseId,
          rootFolder: source.codebase.folder,
          folder: source.folder,
          gitDirectory: source.gitDirectory,
          expectedOrigin: source.codebase.repository.canonicalOrigin,
          branch: source.branch,
          defaultBranch: source.codebase.defaultBranch,
          deleteRemoteBranch: false,
          requireClean: true,
          expectedHeadSha: move.headSha,
        },
        idempotencyKey: `worktree:move:cleanup:${move.id}`,
        timeoutSeconds: 600,
      });
      await prisma.worktreeMove.updateMany({
        where: {
          id: move.id,
          status: {
            in: ["PUSHING", "CHECKING_OUT", "AWAITING_STASH"],
          },
        },
        data: { status: "CLEANING_UP", cleanupJobId: cleanup.id },
      });
      this.publish(source.id, source.codebaseId);
    } catch (error) {
      await prisma.worktreeMove.update({
        where: { id: move.id },
        data: {
          status: "SUCCEEDED_WITH_WARNING",
          warning: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        },
      });
      this.publish(source.id, source.codebaseId);
    }
  }

  private async advanceMoveAfterCheckout(job: {
    id: string;
    payloadJson: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }) {
    const moveId = this.moveIdFromJob(job);
    const prisma = await getPrismaClient();
    const move = await prisma.worktreeMove.findUnique({
      where: { id: moveId },
    });
    if (
      !move ||
      !["PUSHING", "CHECKING_OUT", "AWAITING_STASH"].includes(move.status) ||
      (move.targetJobId && move.targetJobId !== job.id)
    ) {
      return;
    }
    if (job.status !== "SUCCEEDED") {
      await this.failMove(
        move.id,
        move.status,
        job.error || "Could not check out the destination branch",
      );
      return;
    }
    const result = resultObject(job);
    if (result.outcome === "NEEDS_STASH") {
      await prisma.worktreeMove.updateMany({
        where: {
          id: move.id,
          status: {
            in: ["PUSHING", "CHECKING_OUT", "AWAITING_STASH"],
          },
        },
        data: {
          status: "AWAITING_STASH",
          error:
            typeof result.message === "string"
              ? result.message
              : "Destination changes block the branch switch",
        },
      });
      this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
      return;
    }
    if (result.outcome !== "CHECKED_OUT" || !result.worktree) {
      await this.failMove(
        move.id,
        move.status,
        "Destination checkout returned an invalid result",
      );
      return;
    }
    await this.projectMoveDestination(move, result.worktree);
    if (move.deleteSource) {
      await this.scheduleMoveCleanup(move.id);
    } else {
      await prisma.worktreeMove.update({
        where: { id: move.id },
        data: { status: "SUCCEEDED", error: null, finishedAt: new Date() },
      });
      this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
    }
  }

  private async projectDeleteOperation(job: {
    id: string;
    payloadJson: string;
    worktreeId: string | null;
    status: string;
    error: string | null;
  }) {
    const payload: unknown = JSON.parse(job.payloadJson);
    const moveId =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).moveId === "string"
        ? String((payload as Record<string, unknown>).moveId)
        : null;
    const prisma = await getPrismaClient();
    if (moveId) {
      const move = await prisma.worktreeMove.findUnique({
        where: { id: moveId },
      });
      if (
        !move ||
        !["PUSHING", "CHECKING_OUT", "AWAITING_STASH", "CLEANING_UP"].includes(
          move.status,
        ) ||
        (move.cleanupJobId && move.cleanupJobId !== job.id)
      ) {
        return;
      }
      if (job.status !== "SUCCEEDED") {
        await prisma.worktreeMove.update({
          where: { id: move.id },
          data: {
            status: "SUCCEEDED_WITH_WARNING",
            warning:
              job.error ||
              "Destination is ready, but the source worktree was retained",
            finishedAt: new Date(),
          },
        });
        this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
        return;
      }
      await prisma.$transaction([
        prisma.worktree.deleteMany({ where: { id: move.sourceWorktreeId } }),
        prisma.worktreeMove.update({
          where: { id: move.id },
          data: { status: "SUCCEEDED", finishedAt: new Date() },
        }),
      ]);
      this.publish(move.sourceWorktreeId, move.sourceCodebaseId);
      return;
    }
    if (job.status !== "SUCCEEDED" || !job.worktreeId) return;
    const worktree = await prisma.worktree.findUnique({
      where: { id: job.worktreeId },
      select: { codebaseId: true },
    });
    await prisma.worktree.deleteMany({ where: { id: job.worktreeId } });
    this.publish(job.worktreeId, worktree?.codebaseId ?? null);
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
    const checkedAt = new Date(item.checkedAt);
    const updated = await prisma.worktree.updateMany({
      where: {
        id: current.id,
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: checkedAt } }],
      },
      data: {
        branch: item.branch,
        headSha: item.headSha,
        upstream: item.upstream,
        ahead: item.ahead,
        behind: item.behind,
        syncState: item.syncState,
        baseAhead: item.baseAhead,
        baseBehind: item.baseBehind,
        hasStagedChanges: item.hasStagedChanges ?? false,
        hasUnstagedChanges: item.hasUnstagedChanges ?? false,
        pushStatus: item.pushStatus ?? "UNKNOWN",
        availability: item.availability,
        statusError: item.error,
        lastCheckedAt: checkedAt,
      },
    });
    if (updated.count > 0) {
      this.publish(current.id, current.codebaseId);
    }
  }

  private async projectBranchOperation(job: {
    codebaseId: string | null;
    worktreeId: string | null;
    resultJson: string | null;
    status: string;
  }) {
    if (!job.codebaseId || job.status !== "SUCCEEDED" || !job.resultJson) {
      return;
    }
    const result = resultObject({ ...job, error: null });
    if (!result.worktree || typeof result.baseBranch !== "string") return;
    const item = parseWorktreeInventoryItem(result.worktree);
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id: job.codebaseId },
      select: { localBranchesJson: true },
    });
    if (!codebase) return;
    const branchSet = new Set(parseBranches(codebase.localBranchesJson));
    if (item.branch) branchSet.add(item.branch);
    let worktreeId = job.worktreeId;
    await prisma.$transaction(async (transaction) => {
      await transaction.codebase.update({
        where: { id: job.codebaseId! },
        data: {
          localBranchesJson: JSON.stringify(
            [...branchSet].sort((first, second) => first.localeCompare(second)),
          ),
        },
      });
      if (job.worktreeId) {
        const updated = await transaction.worktree.updateMany({
          where: { id: job.worktreeId, codebaseId: job.codebaseId! },
          data: {
            ...this.inventoryData(item),
            gitDirectory: item.gitDirectory,
            baseBranchOverride: result.baseBranch as string,
            missingAt: null,
          },
        });
        if (updated.count !== 1) throw new Error("Worktree no longer exists");
        return;
      }
      const projected = await transaction.worktree.upsert({
        where: {
          codebaseId_gitDirectory: {
            codebaseId: job.codebaseId!,
            gitDirectory: item.gitDirectory,
          },
        },
        create: {
          id: randomUUID(),
          codebaseId: job.codebaseId!,
          gitDirectory: item.gitDirectory,
          ...this.inventoryData(item),
          baseBranchOverride: result.baseBranch as string,
        },
        update: {
          ...this.inventoryData(item),
          baseBranchOverride: result.baseBranch as string,
          missingAt: null,
        },
      });
      worktreeId = projected.id;
    });
    this.publish(worktreeId ?? null, job.codebaseId);
    await this.skillsService?.requestAutoReconcile();
    if (job.worktreeId) await this.restartWatch(job.worktreeId);
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
