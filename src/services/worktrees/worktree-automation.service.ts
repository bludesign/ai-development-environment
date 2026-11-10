import "server-only";
import {
  mergeBaseBranchUpdateOptions,
  prepareBaseBranchUpdates,
  completeBaseBranchUpdates,
  baseBranchUpdateResults,
  type MergeBaseBranchUpdateInput,
} from "./merge-base-branch-updates";

import { randomUUID } from "node:crypto";
import {
  advancePostMergeSwitch,
  getPostMergeSwitchOptions,
  postMergeSwitchView,
  postMergeSwitchRequiresConfirmation,
  preparePostMergeSwitch,
  retryPostMergeSwitch,
  updatePostMergeSwitchSource,
} from "./post-merge-switch";

import { WORKTREE_AUTO_SYNC_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";

import { parseJiraKey } from "@/services/github/github.service";
import type {
  GitHubMergeMethod,
  GitHubPullRequestMergeInput,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestMergeResult,
  GitHubRequestSource,
} from "@/services/github/types";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { PollingService } from "@/services/polling";
import type { WorkflowsService } from "@/services/workflows";
import type { AgentControlService } from "@/services/agent-control";
import { recoverMergeReservations } from "@/services/operation-locks/operation-locks.service";
import { getPrismaClient } from "@/data/prisma-client";
import type { WorktreeAutoSync } from "@/generated/prisma/client";
import { isCodebaseBusyError } from "@/lib/codebase-busy";
import { isDefaultWorktreeBranch } from "@/lib/default-branches";

import {
  validateMergeFollowUps,
  completeMergeTicketFollowUp,
  autoMergeTicketTransitionWarning,
} from "./merge-follow-ups";
import type { WorktreesService } from "./worktrees.service";
import {
  advanceMergeSync,
  cancelMergeSync,
  managedMergeOwnsWorktree,
  MANAGED_MERGE_STATES,
  LEGACY_CODEBASE_BUSY_MESSAGE,
  isTransientMergeError,
  mergeConflictWorkflowOptions,
  type MergeConflictWorkflowInput,
  mergeSyncUnavailableReason,
  prepareMergeSync,
  readMergeSync,
  withMergeSyncLock,
} from "./merge-branch-sync";

const POLLING_OPERATION_ID = "server:worktree-automations";
const POLL_SECONDS = 60;
const TERMINAL_JOB_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
const TERMINAL_WORKFLOW_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

function repositoryParts(nameWithOwner: string): {
  owner: string;
  name: string;
} {
  const [owner, name, extra] = nameWithOwner.split("/");
  if (!owner || !name || extra) {
    throw new Error("A GitHub repository must be in owner/name format");
  }
  return { owner, name };
}

function resultOutcome(resultJson: string | null): string | null {
  if (!resultJson) return null;
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return typeof (parsed as { outcome?: unknown }).outcome === "string"
      ? String((parsed as { outcome: string }).outcome)
      : null;
  } catch {
    return null;
  }
}

function resultPreparationConflictPaths(resultJson: string | null): string[] {
  if (!resultJson) return [];
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const paths = (parsed as { preparationConflictPaths?: unknown })
      .preparationConflictPaths;
    return Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

function syncView(rule: {
  worktreeId: string;
  state: string;
  conflictWorkflowId: string | null;
  conflictWorkflowChoice: string | null;
  lastError: string | null;
  pauseReason: string | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
}) {
  return {
    worktreeId: rule.worktreeId,
    state: rule.state,
    conflictWorkflowId: rule.conflictWorkflowId,
    conflictWorkflowChoice: rule.conflictWorkflowChoice,
    lastError: rule.lastError,
    pauseReason: rule.pauseReason,
    lastSyncedAt: rule.lastSyncedAt?.toISOString() ?? null,
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function mergeView(rule: {
  postMergeSwitchJson?: string | null;
  autoSync?: boolean;
  baseBranchUpdatesJson?: string | null;
  worktreeId: string;
  state: string;
  repositoryNameWithOwner: string;
  pullRequestNumber: number;
  branch: string;
  mergeMethod: string;
  commitHeadline: string;
  commitBody: string;
  authorEmail: string | null;
  deleteWorktree: boolean;
  moveTicketToDone: boolean;
  ticketKey: string | null;
  lastError: string | null;
  updatedAt: Date;
}) {
  return {
    ...rule,
    postMergeSwitch: postMergeSwitchView(rule.postMergeSwitchJson),
    autoSync: rule.autoSync ?? false,
    ticketTransitionError: null as string | null,
    mergeMethod: rule.mergeMethod as GitHubMergeMethod,
    baseBranchUpdateResults: baseBranchUpdateResults(
      rule.baseBranchUpdatesJson,
    ),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

export class WorktreeAutomationService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;
  private readonly mergeOperationTails = new Map<string, Promise<void>>();

  // A manual merge must finish saving its chosen follow-ups before the worker
  // can observe the merged PR and act on an older auto-merge rule.
  private mergeKey(repository: string, number: number) {
    return `${repository.toLowerCase()}:${number}`;
  }

  private async withMergeLock<T>(
    key: string,
    operation: () => Promise<T>,
    worktreeId?: string | null,
  ): Promise<T> {
    const keys = [
      ...new Set([key, ...(worktreeId ? [`worktree:${worktreeId}`] : [])]),
    ];
    const previous = keys.map(
      (key) => this.mergeOperationTails.get(key) ?? Promise.resolve(),
    );
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Reserve both queues before waiting, so PR and worktree locks cannot
    // deadlock when a rule is retargeted to a different pull request.
    for (const key of keys) this.mergeOperationTails.set(key, next);
    await Promise.all(previous);
    try {
      return await operation();
    } finally {
      release();
      for (const key of keys)
        if (this.mergeOperationTails.get(key) === next)
          this.mergeOperationTails.delete(key);
    }
  }

  constructor(
    private readonly worktrees: WorktreesService,
    private readonly github: GitHubService,
    private readonly jira: JiraService,
    private readonly workflows: WorkflowsService,
    private readonly agentControl: AgentControlService,
    private readonly polling?: PollingService,
  ) {
    this.agentControl.registerCompletionObserver(async (job) => {
      if (job.codebaseId) this.changed();
    });
    this.agentControl.registerConnectionHandler(async () => this.changed());
    this.agentControl.registerBuildAdmissionGuard?.((id) =>
      this.adoptNativeAutoMergeForWorktree(id),
    );
    this.polling?.register({
      id: POLLING_OPERATION_ID,
      kind: "WORKTREE_AUTOMATION",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: POLL_SECONDS,
      details: {},
    });
  }

  startRuntime(): void {
    queueMicrotask(() => void this.reconcile());
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reconcile(), POLL_SECONDS * 1_000);
    this.timer.unref();
    this.polling?.schedule(
      POLLING_OPERATION_ID,
      new Date(Date.now() + POLL_SECONDS * 1_000),
    );
  }

  private changed(): void {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    queueMicrotask(() => void this.reconcile());
  }

  private async stopAutoSyncWork(
    rule: {
      activeJobId: string | null;
      workflowRunId: string | null;
    } | null,
  ): Promise<void> {
    if (rule?.activeJobId) {
      await this.agentControl.cancelJob(rule.activeJobId).catch(() => null);
    }
    if (rule?.workflowRunId) {
      await this.workflows
        .lifecycle(rule.workflowRunId, "CANCEL")
        .catch(() => null);
    }
  }

  async autoSync(worktreeId: string) {
    const prisma = await getPrismaClient();
    const rule = await prisma.worktreeAutoSync.findUnique({
      where: { worktreeId },
    });
    return rule ? syncView(rule) : null;
  }

  async configureAutoSync(input: {
    worktreeId: string;
    conflictWorkflowId?: string | null;
    conflictWorkflowChoice?: string | null;
  }) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findFirst({
      where: { id: input.worktreeId, missingAt: null },
      select: {
        id: true,
        branch: true,
        codebaseId: true,
        codebase: {
          select: {
            repositoryId: true,
            defaultBranch: true,
            repository: { select: { defaultBranchPatternsJson: true } },
          },
        },
      },
    });
    if (!worktree?.branch) throw new Error("Auto Sync requires a branch");
    if (isDefaultWorktreeBranch(worktree))
      throw new Error(
        "Default branches use the repository keep up to date setting instead of Auto Sync",
      );
    await this.stopAutoSyncWork(
      await prisma.worktreeAutoSync.findUnique({
        where: { worktreeId: worktree.id },
        select: { activeJobId: true, workflowRunId: true },
      }),
    );
    const workflowId = input.conflictWorkflowId?.trim() || null;
    if (workflowId) {
      const workflow = await prisma.workflow.findUnique({
        where: { id: workflowId },
        select: {
          enabled: true,
          archivedAt: true,
          activeVersionId: true,
          quickActionKind: true,
          quickActionRepositories: {
            select: { repositoryId: true },
          },
        },
      });
      if (
        !workflow?.enabled ||
        workflow.archivedAt ||
        !workflow.activeVersionId ||
        workflow.quickActionKind !== "MERGE_CONFLICT"
      ) {
        throw new Error(
          "Select an enabled merge-conflict quick action workflow",
        );
      }
      if (
        workflow.quickActionRepositories.length > 0 &&
        !workflow.quickActionRepositories.some(
          ({ repositoryId }) => repositoryId === worktree.codebase.repositoryId,
        )
      ) {
        throw new Error(
          "The merge-conflict workflow is not available for this repository",
        );
      }
    }
    const rule = await prisma.worktreeAutoSync.upsert({
      where: { worktreeId: worktree.id },
      create: {
        worktreeId: worktree.id,
        branch: worktree.branch,
        conflictWorkflowId: workflowId,
        conflictWorkflowChoice: input.conflictWorkflowChoice?.trim() || null,
      },
      update: {
        state: "ACTIVE",
        branch: worktree.branch,
        conflictWorkflowId: workflowId,
        conflictWorkflowChoice: input.conflictWorkflowChoice?.trim() || null,
        activeJobId: null,
        workflowRunId: null,
        lastError: null,
        pauseReason: null,
      },
    });
    this.worktrees.publishAutomationChange(worktree.id, worktree.codebaseId);
    this.changed();
    return syncView(rule);
  }

  async cancelAutoSync(worktreeId: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const rule = await prisma.worktreeAutoSync.findUnique({
      where: { worktreeId },
      select: { activeJobId: true, workflowRunId: true },
    });
    await this.stopAutoSyncWork(rule);
    const removed = await prisma.worktreeAutoSync.deleteMany({
      where: { worktreeId },
    });
    this.worktrees.publishAutomationChange(worktreeId);
    return removed.count > 0;
  }

  async retryAutoSync(worktreeId: string) {
    const prisma = await getPrismaClient();
    const rule = await prisma.worktreeAutoSync.update({
      where: { worktreeId },
      data: {
        state: "ACTIVE",
        activeJobId: null,
        workflowRunId: null,
        lastError: null,
        pauseReason: null,
      },
    });
    this.worktrees.publishAutomationChange(worktreeId);
    this.changed();
    return syncView(rule);
  }

  async autoMerge(worktreeId: string) {
    const prisma = await getPrismaClient();
    const rule = await prisma.worktreeAutoMerge.findUnique({
      where: { worktreeId },
    });
    return rule ? mergeView(rule) : null;
  }

  async pullRequestMergeOperation(owner: string, name: string, number: number) {
    const row = await (
      await getPrismaClient()
    ).worktreeAutoMerge.findFirst({
      where: {
        worktree: {
          codebase: {
            repository: {
              canonicalOrigin: `github.com/${owner.toLowerCase()}/${name.toLowerCase()}`,
            },
          },
        },
        pullRequestNumber: number,
        postMergeSwitchJson: { not: null },
      },
      orderBy: { updatedAt: "desc" },
    });
    return row ? mergeView(row) : null;
  }

  private pullRequestState(rule: {
    repositoryNameWithOwner: string;
    pullRequestNumber: number;
    autoSync?: boolean;
  }) {
    const { owner, name } = repositoryParts(rule.repositoryNameWithOwner);
    return rule.autoSync
      ? this.github.pullRequestAutomationState(
          owner,
          name,
          rule.pullRequestNumber,
          true,
        )
      : this.github.pullRequestAutomationState(
          owner,
          name,
          rule.pullRequestNumber,
        );
  }

  async pullRequestMergeOptions(
    owner: string,
    name: string,
    number: number,
    source: GitHubRequestSource,
    worktreeId?: string | null,
  ): Promise<GitHubPullRequestMergeOptions> {
    const options = await this.github.pullRequestMergeOptions(
      owner,
      name,
      number,
      source,
    );
    const prisma = await getPrismaClient();
    const origin = options.headRepositoryNameWithOwner
      ? `github.com/${options.headRepositoryNameWithOwner.toLowerCase()}`
      : null;
    let worktree =
      worktreeId || origin
        ? await prisma.worktree.findFirst({
            where: worktreeId
              ? { id: worktreeId, missingAt: null }
              : {
                  missingAt: null,
                  branch: options.headRefName,
                  codebase: { repository: { canonicalOrigin: origin! } },
                },
            orderBy: { updatedAt: "desc" },
            include: {
              autoMerge: true,
              codebase: { include: { repository: true } },
            },
          })
        : null;
    if (options.state === "MERGED") {
      const saved = await prisma.worktreeAutoMerge.findFirst({
        where: {
          worktree: {
            codebase: {
              repository: {
                canonicalOrigin: `github.com/${owner.toLowerCase()}/${name.toLowerCase()}`,
              },
            },
          },
          pullRequestNumber: number,
          ...(worktreeId ? { worktreeId } : {}),
          postMergeSwitchJson: { not: null },
        },
        include: {
          worktree: {
            include: {
              autoMerge: true,
              codebase: { include: { repository: true } },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });
      if (saved?.worktree && !saved.worktree.missingAt)
        worktree = saved.worktree;
    }
    if (worktreeId && !worktree)
      throw new Error("The linked worktree is no longer available");
    if (
      worktree &&
      (!origin ||
        (options.state !== "MERGED" &&
          worktree.branch !== options.headRefName) ||
        worktree.codebase.repository.canonicalOrigin.toLowerCase() !== origin)
    ) {
      throw new Error(
        "The pull request head repository or branch does not match this worktree",
      );
    }
    const branchTicket = worktree
      ? await this.worktrees.ticketKeyForWorktree(worktree.id)
      : null;
    const settings = await this.github.getSettings();
    const repositories = await prisma.gitHubRepository.findMany();
    const repository = repositories.find(
      (item) =>
        item.nameWithOwner.toLowerCase() === `${owner}/${name}`.toLowerCase(),
    );
    const titleTicket = parseJiraKey(
      options.defaultCommitHeadline,
      repository?.jiraKeyRegex ?? settings.defaultJiraKeyRegex,
    );
    const ticketKey =
      worktreeId && source === "WORKTREE_AUTOMATION"
        ? branchTicket
        : (titleTicket ?? branchTicket);
    const project = ticketKey
      ? await prisma.jiraProject.findUnique({
          where: { key: ticketKey.split("-")[0]! },
          select: { doneStatusId: true },
        })
      : null;
    const rule = worktree?.autoMerge;
    const saved =
      rule &&
      rule.pullRequestNumber === number &&
      rule.repositoryNameWithOwner.toLowerCase() ===
        `${owner}/${name}`.toLowerCase()
        ? rule
        : null;
    const autoSyncBlockedReason = await mergeSyncUnavailableReason(
      worktree?.id,
    );
    const conflictOptions = await mergeConflictWorkflowOptions(
      worktree?.id,
      saved?.syncStateJson,
    );
    const canResolveConflicts =
      !options.autoSyncRequiresConflictWorkflow ||
      conflictOptions.mergeConflictWorkflows.length > 0;
    return {
      ...options,
      ...conflictOptions,
      ...(await getPostMergeSwitchOptions(
        worktree?.id,
        `github.com/${owner.toLowerCase()}/${name.toLowerCase()}`,
        options.baseRefName ?? "",
        saved?.postMergeSwitchJson,
      )),
      canEnableAutoMerge: worktree
        ? Boolean(options.canAutoMergeWithSync && canResolveConflicts)
        : options.canEnableAutoMerge,
      canAutoMergeWithSync:
        !autoSyncBlockedReason &&
        canResolveConflicts &&
        Boolean(options.canAutoMergeWithSync),
      autoSyncBlockedReason:
        autoSyncBlockedReason ??
        (canResolveConflicts
          ? null
          : conflictOptions.conflictWorkflowBlockedReason),
      defaultAutoSync: saved?.autoSync ?? false,
      autoMergeOperation: saved ? mergeView(saved) : null,
      baseBranchUpdateOptions: await mergeBaseBranchUpdateOptions(
        worktree,
        saved?.baseBranchUpdatesJson,
      ),
      defaultMethod:
        saved &&
        options.availableMethods.includes(
          saved.mergeMethod as GitHubMergeMethod,
        )
          ? (saved.mergeMethod as GitHubMergeMethod)
          : options.defaultMethod,
      defaultCommitHeadline:
        saved?.commitHeadline ?? options.defaultCommitHeadline,
      defaultCommitBody: saved?.commitBody ?? options.defaultCommitBody,
      defaultCommitEmail: saved
        ? saved.authorEmail
        : options.defaultCommitEmail,
      defaultMoveTicketToDone:
        saved?.moveTicketToDone ?? options.defaultMoveTicketToDone,
      defaultDeleteWorktree:
        saved?.deleteWorktree ?? options.defaultDeleteWorktree,
      worktreeId: worktree?.id ?? null,
      worktreeFolder: worktree?.folder ?? null,
      canDeleteWorktree: Boolean(worktree && !worktree.primary),
      ticketKey,
      ticketDoneStatusConfigured: Boolean(project?.doneStatusId),
    };
  }

  async mergePullRequest(
    input: GitHubPullRequestMergeInput,
    source: GitHubRequestSource,
  ): Promise<GitHubPullRequestMergeResult> {
    const options = await this.pullRequestMergeOptions(
      input.owner,
      input.name,
      input.number,
      source,
      input.worktreeId,
    );
    return this.withMergeLock(
      this.mergeKey(`${input.owner}/${input.name}`, input.number),
      () =>
        this.mergePullRequestWithFollowUps(input, source, options.worktreeId),
      options.worktreeId,
    );
  }

  private async mergePullRequestWithFollowUps(
    input: GitHubPullRequestMergeInput,
    source: GitHubRequestSource,
    lockedWorktreeId: string | null,
  ): Promise<GitHubPullRequestMergeResult> {
    const options = await this.pullRequestMergeOptions(
      input.owner,
      input.name,
      input.number,
      source,
      input.worktreeId,
    );
    if (options.worktreeId !== lockedWorktreeId)
      throw new Error(
        "The linked worktree changed while waiting. Refresh and retry the merge.",
      );
    validateMergeFollowUps(input, options);
    const savedUpdates =
      input.baseBranchUpdate?.worktreeIds.length && options.worktreeId
        ? await (
            await getPrismaClient()
          ).worktreeAutoMerge.findUnique({
            where: { worktreeId: options.worktreeId },
          })
        : null;
    const baseBranchUpdatesJson = await prepareBaseBranchUpdates(
      options.worktreeId,
      input.baseBranchUpdate,
      savedUpdates?.pullRequestNumber === input.number &&
        savedUpdates.repositoryNameWithOwner.toLowerCase() ===
          `${input.owner}/${input.name}`.toLowerCase()
        ? savedUpdates.baseBranchUpdatesJson
        : null,
    );
    const postMergeSwitchJson = await preparePostMergeSwitch(
      options.worktreeId,
      {
        origin: `github.com/${input.owner.toLowerCase()}/${input.name.toLowerCase()}`,
        branch: options.baseRefName ?? "",
        sourceBranch: options.headRefName,
        sourceSha: options.headRefOid,
      },
      input.switchToDefaultBranch ?? false,
      true,
    );
    const followUpData = {
      repositoryNameWithOwner: `${input.owner}/${input.name}`,
      pullRequestNumber: input.number,
      branch: options.headRefName,
      baseBranchUpdatesJson,
      postMergeSwitchJson,
      mergeMethod: input.method,
      commitHeadline: input.commitHeadline.trim(),
      commitBody: input.commitBody,
      authorEmail: input.authorEmail?.trim() || null,
      deleteWorktree: input.deleteWorktree ?? false,
      moveTicketToDone: input.moveTicketToDone ?? false,
      ticketKey: options.ticketKey,
      ticketMovedAt: null,
      deleteJobId: null,
      lastError: null,
    };
    // Save unattended checkout intent before GitHub can merge, including when the
    // request times out or this process stops immediately after submission.
    if (postMergeSwitchJson && options.worktreeId) {
      const data = {
        ...followUpData,
        state: "MERGING",
        autoSync: false,
        syncStateJson: null,
      };
      await (
        await getPrismaClient()
      ).worktreeAutoMerge.upsert({
        where: { worktreeId: options.worktreeId },
        create: { worktreeId: options.worktreeId, ...data },
        update: data,
      });
    }
    let result: GitHubPullRequestMergeResult;
    try {
      result = await this.github.mergePullRequest(input, source);
    } catch (error) {
      if (postMergeSwitchJson && options.worktreeId) {
        await (
          await getPrismaClient()
        ).worktreeAutoMerge.update({
          where: { worktreeId: options.worktreeId },
          data: {
            state: "ACTION_REQUIRED",
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
        this.worktrees.publishAutomationChange(options.worktreeId);
      }
      throw error;
    }
    if (result.state !== "MERGED") return result;
    try {
      if (options.worktreeId) {
        const prisma = await getPrismaClient();
        const data = {
          ...followUpData,
          state:
            input.moveTicketToDone ||
            input.deleteWorktree ||
            baseBranchUpdatesJson ||
            postMergeSwitchJson
              ? "POST_MERGE"
              : "COMPLETED",
        };
        await prisma.worktreeAutoMerge.upsert({
          where: { worktreeId: options.worktreeId },
          create: { worktreeId: options.worktreeId, ...data },
          update: data,
        });
        this.worktrees.publishAutomationChange(options.worktreeId);
        this.changed();
      } else if (input.moveTicketToDone && options.ticketKey) {
        await this.jira.transitionTicketToConfiguredDone(options.ticketKey);
      }
      return {
        ...result,
        worktreeId: options.worktreeId,
        postMergeSwitch: postMergeSwitchView(postMergeSwitchJson),
        ticketKey: options.ticketKey,
        postMergeError: null,
      };
    } catch (error) {
      // GitHub has already merged. Never turn a follow-up failure into a merge retry.
      return {
        ...result,
        worktreeId: options.worktreeId,
        postMergeSwitch: postMergeSwitchView(postMergeSwitchJson),
        ticketKey: options.ticketKey,
        postMergeError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async configureAutoMerge(
    input: MergeConflictWorkflowInput & {
      switchToDefaultBranch?: boolean | null;
      autoSync?: boolean | null;
      expectedHeadSha?: string | null;
      baseBranchUpdate?: MergeBaseBranchUpdateInput | null;
      worktreeId: string;
      repositoryNameWithOwner: string;
      pullRequestNumber: number;
      method: GitHubMergeMethod;
      commitHeadline: string;
      commitBody: string;
      authorEmail?: string | null;
      deleteWorktree: boolean;
      moveTicketToDone: boolean;
    },
  ) {
    if (
      !input.autoSync &&
      (input.conflictWorkflowId || input.conflictWorkflowChoice)
    )
      throw new Error(
        "Automatic conflict resolution requires Auto sync branch.",
      );
    return this.withMergeLock(
      this.mergeKey(input.repositoryNameWithOwner, input.pullRequestNumber),
      async () => {
        const prisma = await getPrismaClient();
        const worktree = await prisma.worktree.findFirst({
          where: { id: input.worktreeId, missingAt: null },
          select: {
            id: true,
            primary: true,
            branch: true,
            codebaseId: true,
            codebase: {
              select: {
                defaultBranch: true,
                repository: {
                  select: {
                    canonicalOrigin: true,
                    defaultBranchPatternsJson: true,
                  },
                },
              },
            },
          },
        });
        if (!worktree?.branch) throw new Error("Auto Merge requires a branch");
        if (isDefaultWorktreeBranch(worktree))
          throw new Error("Auto Merge is not available for default branches");
        if (input.deleteWorktree && worktree.primary) {
          throw new Error("The primary worktree cannot be deleted after merge");
        }
        const existing = await prisma.worktreeAutoMerge.findUnique({
          where: { worktreeId: worktree.id },
        });
        const ticketKey = await this.worktrees.ticketKeyForWorktree(
          worktree.id,
          worktree.branch,
        );
        if (input.moveTicketToDone) {
          if (!ticketKey) {
            throw new Error("This worktree is not linked to a Jira ticket");
          }
          const project = await prisma.jiraProject.findUnique({
            where: { key: ticketKey.split("-")[0] ?? "" },
            select: { doneStatusId: true },
          });
          if (!project?.doneStatusId) {
            throw new Error(
              "Configure this Jira project's done status before enabling this option",
            );
          }
        }
        const repository = repositoryParts(input.repositoryNameWithOwner);
        const pullRequest = await this.github.pullRequestAutomationState(
          repository.owner,
          repository.name,
          input.pullRequestNumber,
        );
        if (pullRequest.headRefName !== worktree.branch) {
          throw new Error(
            "The pull request does not belong to this worktree branch",
          );
        }
        if (!pullRequest.headRepositoryNameWithOwner) {
          throw new Error("The pull request head repository is unavailable");
        }
        if (
          worktree.codebase.repository.canonicalOrigin.toLowerCase() !==
          `github.com/${pullRequest.headRepositoryNameWithOwner.toLowerCase()}`
        ) {
          throw new Error(
            "The pull request head repository does not match this worktree",
          );
        }
        const baseBranchUpdatesJson = await prepareBaseBranchUpdates(
          worktree.id,
          input.baseBranchUpdate,
          existing?.pullRequestNumber === input.pullRequestNumber &&
            existing.repositoryNameWithOwner.toLowerCase() ===
              input.repositoryNameWithOwner.toLowerCase()
            ? existing.baseBranchUpdatesJson
            : null,
        );
        const postMergeSwitchJson = await preparePostMergeSwitch(
          worktree.id,
          {
            origin: `github.com/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
            branch: pullRequest.baseRefName ?? "",
            sourceBranch: pullRequest.headRefName,
            sourceSha: pullRequest.headRefOid,
          },
          input.switchToDefaultBranch ?? false,
        );
        const retargeting = Boolean(
          existing &&
          (existing.repositoryNameWithOwner.toLowerCase() !==
            input.repositoryNameWithOwner.toLowerCase() ||
            existing.pullRequestNumber !== input.pullRequestNumber),
        );
        const newlyEnabled =
          !existing ||
          retargeting ||
          !["ACTIVE", ...MANAGED_MERGE_STATES].includes(existing.state);
        if (input.autoSync) {
          return withMergeSyncLock(worktree.id, async () => {
            if (
              existing?.autoSync &&
              !retargeting &&
              MANAGED_MERGE_STATES.includes(existing.state)
            )
              return mergeView(existing);
            if (existing?.autoSync)
              await cancelMergeSync(
                existing.syncStateJson,
                this.agentControl,
                this.workflows,
              );
            const ready = await this.github.managedMergeReadiness(
              repository.owner,
              repository.name,
              input.pullRequestNumber,
            );
            if (
              !input.expectedHeadSha ||
              ready.headSha !== input.expectedHeadSha
            )
              throw new Error(
                "The source commit changed. Refresh and review it before enabling Auto Merge.",
              );
            if (ready.state !== "OPEN" || ready.blocker)
              throw new Error(
                ready.blocker ?? "Only open pull requests can use Auto Merge.",
              );
            const choices = await this.github.pullRequestMergeOptions(
              repository.owner,
              repository.name,
              input.pullRequestNumber,
              "WORKTREE_AUTOMATION",
            );
            if (!choices.availableMethods.includes(input.method))
              throw new Error("The selected merge method is not available.");
            if (!input.commitHeadline.trim())
              throw new Error("A commit message is required");
            const syncStateJson = await prepareMergeSync(
              worktree.id,
              ready,
              {
                provider: "GITHUB",
                id: worktree.id,
              },
              input,
            );
            const data = {
              autoSync: true,
              syncStateJson,
              state: "SYNCING",
              repositoryNameWithOwner: input.repositoryNameWithOwner,
              pullRequestNumber: input.pullRequestNumber,
              branch: worktree.branch!,
              mergeMethod: input.method,
              commitHeadline: input.commitHeadline.trim(),
              commitBody: input.commitBody,
              authorEmail: input.authorEmail?.trim() || null,
              baseBranchUpdatesJson,
              postMergeSwitchJson,
              deleteWorktree: input.deleteWorktree,
              moveTicketToDone: input.moveTicketToDone,
              ticketKey,
              ticketMovedAt: null,
              deleteJobId: null,
              lastError: null,
            };
            const rule = await prisma.worktreeAutoMerge.upsert({
              where: { worktreeId: worktree.id },
              create: { worktreeId: worktree.id, ...data },
              update: data,
            });
            try {
              if (retargeting && existing) {
                await this.github.disablePullRequestAutoMerge(
                  {
                    ...repositoryParts(existing.repositoryNameWithOwner),
                    number: existing.pullRequestNumber,
                  },
                  "WORKTREE_AUTOMATION",
                );
              }
              if (ready.nativeAutoMerge)
                await this.github.disablePullRequestAutoMerge(
                  { ...repository, number: input.pullRequestNumber },
                  "WORKTREE_AUTOMATION",
                );
            } catch (error) {
              await prisma.worktreeAutoMerge.update({
                where: { worktreeId: worktree.id },
                data: { state: "ACTION_REQUIRED", lastError: String(error) },
              });
              this.worktrees.publishAutomationChange(
                worktree.id,
                worktree.codebaseId,
              );
              throw error;
            }
            const ticketTransitionError = newlyEnabled
              ? await autoMergeTicketTransitionWarning(this.jira, ticketKey)
              : null;
            this.worktrees.publishAutomationChange(
              worktree.id,
              worktree.codebaseId,
            );
            this.changed();
            return { ...mergeView(rule), ticketTransitionError };
          });
        }
        if (existing?.autoSync)
          await cancelMergeSync(
            existing.syncStateJson,
            this.agentControl,
            this.workflows,
          );
        if (existing && retargeting) {
          const previousRepository = repositoryParts(
            existing.repositoryNameWithOwner,
          );
          const previous = await this.github.pullRequestAutomationState(
            previousRepository.owner,
            previousRepository.name,
            existing.pullRequestNumber,
            true,
          );
          if (previous.state === "OPEN" && previous.autoMergeEnabled)
            await this.github.disablePullRequestAutoMerge(
              { ...previousRepository, number: existing.pullRequestNumber },
              "WORKTREE_AUTOMATION",
            );
        }
        const choices = await this.github.pullRequestMergeOptions(
          repository.owner,
          repository.name,
          input.pullRequestNumber,
          "WORKTREE_AUTOMATION",
        );
        if (
          !choices.canAutoMergeWithSync ||
          !choices.availableMethods.includes(input.method)
        )
          throw new Error(
            "This pull request cannot use Auto Merge with the selected merge method.",
          );
        if (!input.commitHeadline.trim())
          throw new Error("A commit message is required");
        // A native request can merge without consulting local build protection.
        // Linked worktrees therefore use the managed worker even without syncing.
        const current = await this.github.pullRequestAutomationState(
          repository.owner,
          repository.name,
          input.pullRequestNumber,
          true,
        );
        if (current.state === "OPEN" && current.autoMergeEnabled)
          await this.github.disablePullRequestAutoMerge(
            { ...repository, number: input.pullRequestNumber },
            "WORKTREE_AUTOMATION",
          );
        const data = {
          state:
            current.state === "MERGED" ? "POST_MERGE" : "WAITING_REQUIREMENTS",
          autoSync: false,
          syncStateJson: null,
          repositoryNameWithOwner: input.repositoryNameWithOwner,
          pullRequestNumber: input.pullRequestNumber,
          branch: worktree.branch,
          mergeMethod: input.method,
          commitHeadline: input.commitHeadline.trim(),
          commitBody: input.commitBody,
          authorEmail: input.authorEmail?.trim() || null,
          baseBranchUpdatesJson,
          postMergeSwitchJson,
          deleteWorktree: input.deleteWorktree,
          moveTicketToDone: input.moveTicketToDone,
          ticketKey,
          ticketMovedAt: null,
          deleteJobId: null,
          lastError: null,
        };
        const rule = await prisma.worktreeAutoMerge.upsert({
          where: { worktreeId: worktree.id },
          create: { worktreeId: worktree.id, ...data },
          update: data,
        });
        const ticketTransitionError =
          newlyEnabled && current.state !== "MERGED"
            ? await autoMergeTicketTransitionWarning(this.jira, ticketKey)
            : null;
        this.worktrees.publishAutomationChange(
          worktree.id,
          worktree.codebaseId,
        );
        this.changed();
        return { ...mergeView(rule), ticketTransitionError };
      },
      input.worktreeId,
    );
  }

  async forceAutoSync(worktreeId: string, requestId: string) {
    if (!requestId.trim()) throw new Error("requestId is required");
    const prisma = await getPrismaClient();
    const rule = await prisma.worktreeAutoSync.findUnique({
      where: { worktreeId },
    });
    if (
      !rule ||
      rule.state !== "PAUSED" ||
      rule.pauseReason !== "PREPARATION_CONFLICT"
    ) {
      throw new Error("Auto Sync is not paused for a preparation conflict");
    }
    const job = await this.worktrees.createAutoSyncJob(
      worktreeId,
      "SYNC",
      rule.branch,
      requestId,
      true,
    );
    await prisma.worktreeAutoSync.update({
      where: { worktreeId },
      data: {
        state: "SYNCING",
        activeJobId: job.id,
        workflowRunId: null,
        lastError: null,
        pauseReason: null,
      },
    });
    this.worktrees.publishAutomationChange(worktreeId);
    this.changed();
    return job;
  }

  async cancelAutoMerge(worktreeId: string): Promise<boolean> {
    const saved = await (
      await getPrismaClient()
    ).worktreeAutoMerge.findUnique({ where: { worktreeId } });
    const key = saved
      ? this.mergeKey(saved.repositoryNameWithOwner, saved.pullRequestNumber)
      : `worktree:${worktreeId}`;
    const cancel = async () => {
      const prisma = await getPrismaClient();
      const rule = await prisma.worktreeAutoMerge.findUnique({
        where: { worktreeId },
      });
      const currentWorktree = rule
        ? await prisma.worktree.findUnique({
            where: { id: worktreeId },
            include: {
              pullRequest: true,
              codebase: { include: { repository: true } },
            },
          })
        : null;
      if (rule && !currentWorktree) return false;
      const currentRequest = currentWorktree?.pullRequest;
      const staleRule =
        rule &&
        (currentWorktree?.branch !== rule.branch ||
          (currentRequest &&
            (currentRequest.number !== rule.pullRequestNumber ||
              currentRequest.repositoryNameWithOwner.toLowerCase() !==
                rule.repositoryNameWithOwner.toLowerCase())));
      if (!rule || staleRule) {
        const worktree = await this.worktrees.refreshPullRequest(worktreeId);
        const linked = worktree.pullRequest;
        if (!linked || !worktree.branch) return false;
        const repository = repositoryParts(linked.repositoryNameWithOwner);
        const state = await this.github.pullRequestAutomationState(
          repository.owner,
          repository.name,
          linked.number,
          true,
        );
        if (
          state.headRefName !== worktree.branch ||
          !state.headRepositoryNameWithOwner ||
          `github.com/${state.headRepositoryNameWithOwner.toLowerCase()}` !==
            worktree.codebase.repository.canonicalOrigin.toLowerCase()
        )
          throw new Error("The pull request does not match this worktree");
        if (state.state !== "OPEN" || !state.autoMergeEnabled) return false;
        await this.github.disablePullRequestAutoMerge(
          { ...repository, number: linked.number },
          "WORKTREE_AUTOMATION",
        );
        await this.worktrees.refreshPullRequest(worktreeId);
        this.worktrees.publishAutomationChange(worktreeId, worktree.codebaseId);
        return true;
      }
      const repository = repositoryParts(rule.repositoryNameWithOwner);
      const state = await this.github.pullRequestAutomationState(
        repository.owner,
        repository.name,
        rule.pullRequestNumber,
        true,
      );
      if (
        state.headRefName !== currentWorktree!.branch ||
        !state.headRepositoryNameWithOwner ||
        `github.com/${state.headRepositoryNameWithOwner.toLowerCase()}` !==
          currentWorktree!.codebase.repository.canonicalOrigin.toLowerCase()
      )
        throw new Error("The pull request does not match this worktree");
      if (rule.autoSync)
        await cancelMergeSync(
          rule.syncStateJson,
          this.agentControl,
          this.workflows,
        );
      if (state.state === "OPEN" && state.autoMergeEnabled) {
        await this.github.disablePullRequestAutoMerge(
          {
            ...repository,
            number: rule.pullRequestNumber,
          },
          "WORKTREE_AUTOMATION",
        );
      }
      if (state.state === "MERGED") {
        if (rule.autoSync) {
          const intent = readMergeSync(rule.syncStateJson);
          if (
            state.headRefOid !== intent.headSha ||
            state.headRefName !== intent.sourceBranch ||
            `github.com/${state.headRepositoryNameWithOwner?.toLowerCase()}` !==
              intent.sourceOrigin.toLowerCase()
          )
            throw new Error(
              "A different source commit merged. Review follow-ups manually.",
            );
        }
        await prisma.worktreeAutoMerge.update({
          where: { worktreeId },
          data: { state: "POST_MERGE", lastError: null },
        });
        this.changed();
      } else await prisma.worktreeAutoMerge.delete({ where: { worktreeId } });
      this.worktrees.publishAutomationChange(worktreeId);
      return true;
    };
    return this.withMergeLock(key, cancel, worktreeId);
  }

  async retryAutoMerge(worktreeId: string) {
    return this.withMergeLock(`worktree:${worktreeId}`, async () => {
      const prisma = await getPrismaClient();
      const existing = await prisma.worktreeAutoMerge.findUniqueOrThrow({
        where: { worktreeId },
      });
      const pullRequest = await this.pullRequestState(existing);
      if (existing.postMergeSwitchJson && pullRequest.state !== "MERGED")
        throw new Error(
          "The merge must be confirmed before retrying the checkout switch.",
        );
      if (existing.autoSync && pullRequest.state !== "MERGED")
        throw new Error(
          "Refresh and review the current source commit, then resume Auto Merge from its configuration.",
        );
      const state =
        pullRequest.state === "MERGED" ? "POST_MERGE" : "WAITING_REQUIREMENTS";
      const rule = await prisma.worktreeAutoMerge.update({
        where: { worktreeId },
        data: {
          state,
          lastError: null,
          deleteJobId: null,
          postMergeSwitchJson: await retryPostMergeSwitch(
            existing.postMergeSwitchJson,
            this.agentControl,
          ),
        },
      });
      this.worktrees.publishAutomationChange(worktreeId);
      this.changed();
      return mergeView(rule);
    });
  }

  /** Adopt previously enabled native requests before a linked checkout starts a build. */
  async adoptNativeAutoMergeForWorktree(worktreeId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      include: {
        pullRequest: true,
        codebase: { include: { repository: true } },
      },
    });
    if (!worktree?.branch) return;
    const origin = worktree.codebase.repository.canonicalOrigin;
    await recoverMergeReservations(
      origin,
      worktree.branch,
      async (recovery?: {
        provider?: string;
        owner?: string;
        name?: string;
        number?: number;
      }) => {
        if (
          recovery?.provider !== "GITHUB" ||
          !recovery.owner ||
          !recovery.name ||
          !recovery.number
        )
          return false;
        const remote = await this.github.pullRequestAutomationState(
          recovery.owner,
          recovery.name,
          recovery.number,
          true,
        );
        return remote.state !== "OPEN";
      },
    );
    const rules = await prisma.worktreeAutoMerge.findMany({
      where: {
        branch: worktree.branch,
        state: { in: ["ACTIVE", ...MANAGED_MERGE_STATES] },
        worktree: {
          missingAt: null,
          codebase: { repository: { canonicalOrigin: origin } },
        },
      },
    });
    for (const savedRule of rules)
      await this.withMergeLock(
        this.mergeKey(
          savedRule.repositoryNameWithOwner,
          savedRule.pullRequestNumber,
        ),
        async () => {
          const rule = await prisma.worktreeAutoMerge.findUnique({
            where: { worktreeId: savedRule.worktreeId },
          });
          if (
            !rule ||
            rule.branch !== worktree.branch ||
            this.mergeKey(
              rule.repositoryNameWithOwner,
              rule.pullRequestNumber,
            ) !==
              this.mergeKey(
                savedRule.repositoryNameWithOwner,
                savedRule.pullRequestNumber,
              ) ||
            !["ACTIVE", ...MANAGED_MERGE_STATES].includes(rule.state)
          )
            return;
          const repository = repositoryParts(rule.repositoryNameWithOwner);
          let remote = await this.github.pullRequestAutomationState(
            repository.owner,
            repository.name,
            rule.pullRequestNumber,
            true,
          );
          await recoverMergeReservations(
            origin,
            worktree.branch!,
            async (recovery?: {
              provider?: string;
              owner?: string;
              name?: string;
              number?: number;
            }) =>
              recovery?.provider === "GITHUB" &&
              recovery.owner?.toLowerCase() ===
                repository.owner.toLowerCase() &&
              recovery.name?.toLowerCase() === repository.name.toLowerCase() &&
              recovery.number === rule.pullRequestNumber &&
              remote.state !== "OPEN",
          );
          if (remote.state === "OPEN" && remote.autoMergeEnabled) {
            await this.github.disablePullRequestAutoMerge(
              { ...repository, number: rule.pullRequestNumber },
              "WORKTREE_AUTOMATION",
            );
            remote = await this.github.pullRequestAutomationState(
              repository.owner,
              repository.name,
              rule.pullRequestNumber,
              true,
            );
            if (remote.autoMergeEnabled)
              throw new Error(
                "Native Auto Merge is still enabled for this worktree.",
              );
          }
          if (!rule.autoSync)
            await prisma.worktreeAutoMerge.update({
              where: { worktreeId: rule.worktreeId },
              data: {
                state:
                  remote.state === "MERGED"
                    ? "POST_MERGE"
                    : "WAITING_REQUIREMENTS",
                lastError: null,
              },
            });
          this.worktrees.publishAutomationChange(rule.worktreeId);
        },
        savedRule.worktreeId,
      );
    const linked = worktree.pullRequest;
    if (
      linked &&
      !rules.some(
        (rule) =>
          rule.pullRequestNumber === linked.number &&
          rule.repositoryNameWithOwner.toLowerCase() ===
            linked.repositoryNameWithOwner.toLowerCase(),
      )
    ) {
      const repository = repositoryParts(linked.repositoryNameWithOwner);
      const remote = await this.github.pullRequestAutomationState(
        repository.owner,
        repository.name,
        linked.number,
        true,
      );
      await recoverMergeReservations(
        origin,
        worktree.branch,
        async (recovery?: {
          provider?: string;
          owner?: string;
          name?: string;
          number?: number;
        }) =>
          recovery?.provider === "GITHUB" &&
          recovery.owner?.toLowerCase() === repository.owner.toLowerCase() &&
          recovery.name?.toLowerCase() === repository.name.toLowerCase() &&
          recovery.number === linked.number &&
          remote.state !== "OPEN",
      );
      if (remote.state === "OPEN" && remote.autoMergeEnabled)
        throw new Error(
          "Disable the provider's native Auto Merge before building this worktree.",
        );
    }
  }

  private async reconcile(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      const operation = async () => {
        do {
          this.rerunRequested = false;
          await this.reconcileAutoMerge();
          await this.reconcileAutoSync();
        } while (this.rerunRequested);
      };
      if (this.polling) {
        await this.polling.run(POLLING_OPERATION_ID, operation);
      } else {
        await operation();
      }
    } catch {
      // The polling surface records coordinator failures; the next interval
      // retries without taking down the server runtime.
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async recoverLegacyAutoSync(
    rule: WorktreeAutoSync & { worktree: { codebaseId: string } },
  ) {
    if (
      rule.state !== "PAUSED" ||
      rule.pauseReason !== "ERROR" ||
      rule.lastError !== LEGACY_CODEBASE_BUSY_MESSAGE
    )
      return null;
    const prisma = await getPrismaClient();
    let workflowRunId = rule.workflowRunId;
    if (!workflowRunId && !rule.activeJobId && rule.conflictWorkflowId) {
      const job = await prisma.agentJob.findFirst({
        where: {
          worktreeId: rule.worktreeId,
          codebaseId: rule.worktree.codebaseId,
          kind: WORKTREE_AUTO_SYNC_JOB_KIND,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const current = await prisma.worktree.findUnique({
        where: { id: rule.worktreeId },
        select: {
          codebaseId: true,
          branch: true,
          folder: true,
          gitDirectory: true,
          codebase: {
            select: {
              defaultBranch: true,
              repository: {
                select: {
                  canonicalOrigin: true,
                  defaultBranchPatternsJson: true,
                },
              },
            },
          },
        },
      });
      let matchingDispatch = false;
      try {
        const payload = JSON.parse(job?.payloadJson ?? "null");
        matchingDispatch =
          Boolean(current) &&
          current!.codebaseId === rule.worktree.codebaseId &&
          current!.branch === rule.branch &&
          payload?.expectedBranch === rule.branch &&
          payload?.folder === current!.folder &&
          payload?.gitDirectory === current!.gitDirectory &&
          typeof payload?.expectedOrigin === "string" &&
          payload.expectedOrigin.toLowerCase() ===
            current!.codebase.repository.canonicalOrigin.toLowerCase() &&
          payload?.phase === "SYNC" &&
          !payload?.mergeGuard;
      } catch {
        // Without a durable dispatch identity, normal sync checks fail closed.
      }
      if (
        matchingDispatch &&
        job?.status === "SUCCEEDED" &&
        job.finishedAt &&
        job.finishedAt <= rule.updatedAt &&
        resultOutcome(job.resultJson) === "CONFLICT"
      ) {
        const runs = await prisma.workflowRun.findMany({
          where: {
            worktreeId: rule.worktreeId,
            workflowId: rule.conflictWorkflowId,
            triggerSubjectKey: `auto-sync:${rule.worktreeId}:${job.id}`,
            status: "SUCCEEDED",
            finishedAt: { gte: job.finishedAt, lte: rule.updatedAt },
          },
          select: { id: true },
          take: 2,
        });
        if (runs.length === 1) workflowRunId = runs[0]!.id;
      }
    }
    const data = {
      state: rule.activeJobId
        ? "SYNCING"
        : workflowRunId
          ? "RESOLVING"
          : "ACTIVE",
      workflowRunId,
      lastError: null,
      pauseReason: null,
    };
    const updated = await prisma.worktreeAutoSync.updateMany({
      where: {
        worktreeId: rule.worktreeId,
        state: "PAUSED",
        pauseReason: "ERROR",
        lastError: LEGACY_CODEBASE_BUSY_MESSAGE,
        updatedAt: rule.updatedAt,
      },
      data,
    });
    return updated.count ? data : null;
  }

  private async reconcileAutoSync(): Promise<void> {
    const prisma = await getPrismaClient();
    const rules = await prisma.worktreeAutoSync.findMany({
      where: {
        OR: [
          { state: { in: ["ACTIVE", "SYNCING", "RESOLVING"] } },
          { state: "PAUSED" },
        ],
      },
      include: { worktree: { select: { codebaseId: true } } },
      orderBy: [{ updatedAt: "asc" }, { worktreeId: "asc" }],
    });
    for (const savedRule of rules) {
      await withMergeSyncLock(savedRule.worktreeId, async () => {
        let rule = savedRule;
        try {
          const current = await prisma.worktree.findUnique({
            where: { id: rule.worktreeId },
            select: {
              branch: true,
              codebase: {
                select: {
                  defaultBranch: true,
                  repository: { select: { defaultBranchPatternsJson: true } },
                },
              },
            },
          });
          if (current?.codebase && isDefaultWorktreeBranch(current)) {
            await this.stopAutoSyncWork(rule);
            await prisma.worktreeAutoSync.deleteMany({
              where: { worktreeId: rule.worktreeId },
            });
            return;
          }
          if (rule.state === "PAUSED") {
            const recovered = await this.recoverLegacyAutoSync(rule);
            if (!recovered) return;
            rule = { ...rule, ...recovered };
          }
          if (await managedMergeOwnsWorktree(rule.worktreeId)) return;
          if (current?.branch !== rule.branch) {
            throw new Error(
              "Auto Sync paused because the worktree branch changed",
            );
          }
          if (rule.state === "ACTIVE") {
            const recent = await prisma.agentJob.findMany({
              where: {
                worktreeId: rule.worktreeId,
                codebaseId: rule.worktree.codebaseId,
                kind: WORKTREE_AUTO_SYNC_JOB_KIND,
                status: "SUCCEEDED",
                finishedAt: {
                  gte: new Date(Date.now() - POLL_SECONDS * 1_000),
                },
              },
              select: { resultJson: true },
            });
            if (
              recent.some((job) =>
                ["SYNCED", "NO_CHANGE"].includes(
                  resultOutcome(job.resultJson) ?? "",
                ),
              )
            )
              return;
            const job = await this.worktrees.createAutoSyncJob(
              rule.worktreeId,
              "SYNC",
              rule.branch,
              randomUUID(),
            );
            await prisma.worktreeAutoSync.update({
              where: { worktreeId: rule.worktreeId },
              data: {
                state: "SYNCING",
                activeJobId: job.id,
                lastError: null,
                pauseReason: null,
              },
            });
            return;
          }
          if (rule.state === "RESOLVING") {
            if (!rule.workflowRunId) {
              throw new Error("The conflict workflow run is missing");
            }
            const run = await this.workflows.run(rule.workflowRunId);
            if (!run || !TERMINAL_WORKFLOW_STATUSES.has(run.status)) return;
            if (run.status !== "SUCCEEDED") {
              throw new Error(
                `The conflict workflow ${run.status.toLowerCase()}`,
              );
            }
            const job = await this.worktrees.createAutoSyncJob(
              rule.worktreeId,
              "FINALIZE",
              rule.branch,
              randomUUID(),
            );
            await prisma.worktreeAutoSync.update({
              where: { worktreeId: rule.worktreeId },
              data: {
                state: "SYNCING",
                activeJobId: job.id,
                workflowRunId: null,
                pauseReason: null,
              },
            });
            return;
          }
          if (!rule.activeJobId)
            throw new Error("The Auto Sync job is missing");
          const job = await this.agentControl.getJob(rule.activeJobId);
          if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return;
          if (job.status !== "SUCCEEDED") {
            throw new Error(
              job.error || `Auto Sync ${job.status.toLowerCase()}`,
            );
          }
          const outcome = resultOutcome(job.resultJson);
          if (outcome === "PREPARATION_CONFLICT") {
            const paths = resultPreparationConflictPaths(job.resultJson);
            await prisma.worktreeAutoSync.update({
              where: { worktreeId: rule.worktreeId },
              data: {
                state: "PAUSED",
                activeJobId: null,
                workflowRunId: null,
                lastError:
                  "Auto Sync paused because repository preparations block the rebase" +
                  (paths.length ? `: ${paths.join(", ")}` : ""),
                pauseReason: "PREPARATION_CONFLICT",
              },
            });
            return;
          }
          if (outcome === "CONFLICT") {
            if (!rule.conflictWorkflowId) {
              await prisma.worktreeAutoSync.update({
                where: { worktreeId: rule.worktreeId },
                data: {
                  state: "PAUSED",
                  activeJobId: null,
                  workflowRunId: null,
                  lastError:
                    "Auto Sync paused because the rebase has merge conflicts",
                  pauseReason: "REBASE_CONFLICT",
                },
              });
              return;
            }
            const run = await this.workflows.trigger({
              workflowId: rule.conflictWorkflowId,
              resourceKind: "WORKTREE",
              resourceId: rule.worktreeId,
              subjectKey: `auto-sync:${rule.worktreeId}:${job.id}`,
              choice: rule.conflictWorkflowChoice,
            });
            if (!run) throw new Error("The conflict workflow did not start");
            await prisma.worktreeAutoSync.update({
              where: { worktreeId: rule.worktreeId },
              data: {
                state: "RESOLVING",
                activeJobId: null,
                workflowRunId: run.id,
                lastError: null,
                pauseReason: null,
              },
            });
            return;
          }
          if (outcome === "UNRESOLVED") {
            throw new Error(
              "The conflict workflow did not fully resolve the rebase",
            );
          }
          if (outcome !== "SYNCED" && outcome !== "NO_CHANGE") {
            throw new Error("The Auto Sync job returned an unknown result");
          }
          await prisma.worktreeAutoSync.update({
            where: { worktreeId: rule.worktreeId },
            data: {
              state: "ACTIVE",
              activeJobId: null,
              workflowRunId: null,
              lastError: null,
              pauseReason: null,
              ...(outcome === "SYNCED" ? { lastSyncedAt: new Date() } : {}),
            },
          });
        } catch (error) {
          // No job was dispatched. Keep the phase and workflow identity so the
          // next completion or polling pass can take the newly available slot.
          if (isCodebaseBusyError(error)) return;
          if (
            rule.state === "PAUSED" &&
            rule.lastError === LEGACY_CODEBASE_BUSY_MESSAGE &&
            isTransientMergeError(error)
          )
            return;
          const message =
            error instanceof Error ? error.message : String(error);
          const transient =
            /offline|busy|already has an active job|temporarily/i.test(message);
          if (transient && rule.state === "RESOLVING") return;
          const pauseReason = /branch changed/i.test(message)
            ? "BRANCH_CHANGED"
            : "ERROR";
          await prisma.worktreeAutoSync.updateMany({
            where: { worktreeId: rule.worktreeId },
            data: {
              state: transient ? "ACTIVE" : "PAUSED",
              activeJobId: null,
              workflowRunId: null,
              lastError: message,
              pauseReason: transient ? null : pauseReason,
            },
          });
        } finally {
          this.worktrees.publishAutomationChange(
            rule.worktreeId,
            rule.worktree.codebaseId,
          );
        }
      });
    }
  }

  private async reconcileAutoMerge(): Promise<void> {
    return this.reconcileAutoMergeRules();
  }

  private async reconcileAutoMergeRules(): Promise<void> {
    const prisma = await getPrismaClient();
    const rules = await prisma.worktreeAutoMerge.findMany({
      where: {
        OR: [
          { state: { in: ["ACTIVE", "POST_MERGE", ...MANAGED_MERGE_STATES] } },
          { state: "ACTION_REQUIRED" },
        ],
      },
      include: {
        worktree: {
          select: {
            codebaseId: true,
            branch: true,
            headSha: true,
            primary: true,
            codebase: {
              select: {
                defaultBranch: true,
                repository: {
                  select: {
                    canonicalOrigin: true,
                    defaultBranchPatternsJson: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const results = await Promise.allSettled(
      rules.map((savedRule) =>
        this.withMergeLock(
          this.mergeKey(
            savedRule.repositoryNameWithOwner,
            savedRule.pullRequestNumber,
          ),
          async () => {
            // Discovery may race a manual merge. Reload only this PR after
            // taking its lock so its newly saved follow-ups are authoritative.
            const refreshed = await prisma.worktreeAutoMerge.findMany({
              where: { worktreeId: savedRule.worktreeId },
              include: {
                worktree: {
                  select: {
                    codebaseId: true,
                    branch: true,
                    headSha: true,
                    primary: true,
                    codebase: {
                      select: {
                        defaultBranch: true,
                        repository: {
                          select: {
                            canonicalOrigin: true,
                            defaultBranchPatternsJson: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            });
            const current = refreshed.find(
              (candidate) => candidate.worktreeId === savedRule.worktreeId,
            );
            if (
              !current ||
              this.mergeKey(
                current.repositoryNameWithOwner,
                current.pullRequestNumber,
              ) !==
                this.mergeKey(
                  savedRule.repositoryNameWithOwner,
                  savedRule.pullRequestNumber,
                ) ||
              ![
                "ACTIVE",
                "POST_MERGE",
                ...MANAGED_MERGE_STATES,
                "ACTION_REQUIRED",
              ].includes(current.state)
            )
              return;
            let rule = current;
            try {
              const repository = repositoryParts(rule.repositoryNameWithOwner);
              if (
                isDefaultWorktreeBranch(rule.worktree) &&
                !rule.postMergeSwitchJson &&
                rule.state !== "POST_MERGE"
              ) {
                if (rule.autoSync)
                  await cancelMergeSync(
                    rule.syncStateJson,
                    this.agentControl,
                    this.workflows,
                  );
                const remote = await this.github.pullRequestAutomationState(
                  repository.owner,
                  repository.name,
                  rule.pullRequestNumber,
                  true,
                );
                if (remote.state === "MERGED") {
                  if (
                    remote.headRefName !== rule.branch ||
                    !remote.headRepositoryNameWithOwner ||
                    `github.com/${remote.headRepositoryNameWithOwner.toLowerCase()}` !==
                      rule.worktree.codebase.repository.canonicalOrigin.toLowerCase() ||
                    rule.worktree.branch !== rule.branch
                  )
                    throw new Error(
                      "The pull request source no longer matches this worktree.",
                    );
                  if (rule.autoSync) {
                    const intent = readMergeSync(rule.syncStateJson);
                    if (
                      remote.headRefOid !== intent.headSha ||
                      remote.headRefName !== intent.sourceBranch ||
                      `github.com/${remote.headRepositoryNameWithOwner.toLowerCase()}` !==
                        intent.sourceOrigin.toLowerCase()
                    )
                      throw new Error(
                        "A different source commit merged. Review follow-ups manually.",
                      );
                  }
                  await prisma.worktreeAutoMerge.update({
                    where: { worktreeId: rule.worktreeId },
                    data: { state: "POST_MERGE", lastError: null },
                  });
                  this.rerunRequested = true;
                  return;
                }
                if (remote.state === "OPEN" && remote.autoMergeEnabled)
                  await this.github.disablePullRequestAutoMerge(
                    { ...repository, number: rule.pullRequestNumber },
                    "WORKTREE_AUTOMATION",
                  );
                await prisma.worktreeAutoMerge.deleteMany({
                  where: { worktreeId: rule.worktreeId },
                });
                return;
              }
              if (rule.state === "ACTION_REQUIRED") {
                const recoverSwitch =
                  postMergeSwitchView(rule.postMergeSwitchJson)?.state ===
                  "PENDING";
                if (
                  !recoverSwitch &&
                  rule.lastError !== LEGACY_CODEBASE_BUSY_MESSAGE
                )
                  return;
                const confirmed = await this.github.pullRequestAutomationState(
                  repository.owner,
                  repository.name,
                  rule.pullRequestNumber,
                  true,
                );
                const expectedHead = rule.autoSync
                  ? readMergeSync(rule.syncStateJson).headSha
                  : rule.worktree.headSha;
                if (
                  confirmed.state !== "MERGED" ||
                  confirmed.headRefName !== rule.branch ||
                  confirmed.headRefOid !== expectedHead ||
                  !confirmed.headRepositoryNameWithOwner ||
                  `github.com/${confirmed.headRepositoryNameWithOwner.toLowerCase()}` !==
                    rule.worktree.codebase.repository.canonicalOrigin.toLowerCase()
                )
                  return;
                const recovered = await prisma.worktreeAutoMerge.updateMany({
                  where: {
                    worktreeId: rule.worktreeId,
                    state: "ACTION_REQUIRED",
                    lastError: rule.lastError,
                    updatedAt: rule.updatedAt,
                  },
                  data: { state: "POST_MERGE", lastError: null },
                });
                if (!recovered.count) return;
                rule = { ...rule, state: "POST_MERGE", lastError: null };
              }
              if (rule.autoSync && rule.state !== "POST_MERGE") {
                const merged = await advanceMergeSync({
                  ...rule,
                  worktrees: this.worktrees,
                  agents: this.agentControl,
                  workflows: this.workflows,
                  readiness: () =>
                    this.github.managedMergeReadiness(
                      repository.owner,
                      repository.name,
                      rule.pullRequestNumber,
                    ),
                  save: async ({ acceptedHeadSha, ...data }) => {
                    if (acceptedHeadSha && rule.postMergeSwitchJson) {
                      rule = {
                        ...rule,
                        postMergeSwitchJson: updatePostMergeSwitchSource(
                          rule.postMergeSwitchJson,
                          acceptedHeadSha,
                        ),
                      };
                    }
                    return prisma.worktreeAutoMerge.update({
                      where: { worktreeId: rule.worktreeId },
                      data: {
                        ...data,
                        ...(acceptedHeadSha
                          ? { postMergeSwitchJson: rule.postMergeSwitchJson }
                          : {}),
                      },
                    });
                  },
                  merge: (sha, targetSha) =>
                    this.github.mergePullRequest(
                      {
                        ...repository,
                        number: rule.pullRequestNumber,
                        method: rule.mergeMethod as GitHubMergeMethod,
                        commitHeadline: rule.commitHeadline,
                        commitBody: rule.commitBody,
                        authorEmail: rule.authorEmail,
                        expectedHeadSha: sha,
                        expectedTargetSha: targetSha,
                      },
                      "WORKTREE_AUTOMATION",
                    ),
                });
                if (merged) {
                  await prisma.worktreeAutoMerge.update({
                    where: { worktreeId: rule.worktreeId },
                    data: { state: "POST_MERGE", lastError: null },
                  });
                  this.rerunRequested = true;
                }
                return;
              }
              if (!rule.autoSync && rule.state !== "POST_MERGE") {
                let remote = await this.github.pullRequestAutomationState(
                  repository.owner,
                  repository.name,
                  rule.pullRequestNumber,
                  true,
                );
                if (
                  remote.headRefName !== rule.branch ||
                  !remote.headRepositoryNameWithOwner ||
                  `github.com/${remote.headRepositoryNameWithOwner.toLowerCase()}` !==
                    rule.worktree.codebase.repository.canonicalOrigin.toLowerCase() ||
                  rule.worktree.branch !== rule.branch
                )
                  throw new Error(
                    "The pull request source no longer matches this worktree.",
                  );
                if (remote.state === "MERGED") {
                  await prisma.worktreeAutoMerge.update({
                    where: { worktreeId: rule.worktreeId },
                    data: { state: "POST_MERGE", lastError: null },
                  });
                  this.rerunRequested = true;
                  return;
                }
                if (remote.state !== "OPEN")
                  throw new Error("The pull request closed without merging");
                if (
                  postMergeSwitchRequiresConfirmation(rule.postMergeSwitchJson)
                )
                  throw new Error(
                    "GitHub has not confirmed this merge. Refresh its status before retrying the checkout follow-up.",
                  );
                if (remote.autoMergeEnabled) {
                  await this.github.disablePullRequestAutoMerge(
                    { ...repository, number: rule.pullRequestNumber },
                    "WORKTREE_AUTOMATION",
                  );
                  remote = await this.github.pullRequestAutomationState(
                    repository.owner,
                    repository.name,
                    rule.pullRequestNumber,
                    true,
                  );
                  if (remote.autoMergeEnabled)
                    throw new Error(
                      "Native Auto Merge is still enabled for this worktree.",
                    );
                  if (remote.state === "MERGED") {
                    await prisma.worktreeAutoMerge.update({
                      where: { worktreeId: rule.worktreeId },
                      data: { state: "POST_MERGE", lastError: null },
                    });
                    this.rerunRequested = true;
                    return;
                  }
                }
                const choices = await this.github.pullRequestMergeOptions(
                  repository.owner,
                  repository.name,
                  rule.pullRequestNumber,
                  "WORKTREE_AUTOMATION",
                );
                if (!choices.canMerge) {
                  await prisma.worktreeAutoMerge.update({
                    where: { worktreeId: rule.worktreeId },
                    data: {
                      state: "WAITING_REQUIREMENTS",
                      lastError: choices.blockedReason,
                    },
                  });
                  return;
                }
                await prisma.worktreeAutoMerge.update({
                  where: { worktreeId: rule.worktreeId },
                  data: { state: "MERGING", lastError: null },
                });
                const result = await this.github.mergePullRequest(
                  {
                    ...repository,
                    number: rule.pullRequestNumber,
                    method: rule.mergeMethod as GitHubMergeMethod,
                    commitHeadline: rule.commitHeadline,
                    commitBody: rule.commitBody,
                    authorEmail: rule.authorEmail,
                  },
                  "WORKTREE_AUTOMATION",
                );
                if (result.state !== "MERGED") return;
                await prisma.worktreeAutoMerge.update({
                  where: { worktreeId: rule.worktreeId },
                  data: { state: "POST_MERGE", lastError: null },
                });
                this.rerunRequested = true;
                return;
              }
              if (rule.postMergeSwitchJson) {
                const confirmed = await this.github.pullRequestAutomationState(
                  repository.owner,
                  repository.name,
                  rule.pullRequestNumber,
                  true,
                );
                if (
                  confirmed.state !== "MERGED" ||
                  !confirmed.headRepositoryNameWithOwner ||
                  `github.com/${confirmed.headRepositoryNameWithOwner.toLowerCase()}` !==
                    rule.worktree.codebase.repository.canonicalOrigin.toLowerCase()
                )
                  throw new Error(
                    "The merged pull request does not match the reviewed checkout.",
                  );
                const completed = await advancePostMergeSwitch(
                  rule.postMergeSwitchJson,
                  {
                    origin: `github.com/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
                    branch: confirmed.baseRefName ?? "",
                    sourceBranch: confirmed.headRefName,
                    sourceSha: confirmed.headRefOid,
                    mergeCommitSha: confirmed.mergeCommitSha ?? null,
                  },
                  this.worktrees,
                  this.agentControl,
                  async (json) => {
                    rule = { ...rule, postMergeSwitchJson: json };
                    await prisma.worktreeAutoMerge.update({
                      where: { worktreeId: rule.worktreeId },
                      data: { postMergeSwitchJson: json },
                    });
                  },
                );
                if (!completed) return;
              }
              if (rule.baseBranchUpdatesJson) {
                const confirmed = await this.pullRequestState(rule);
                if (
                  confirmed.state !== "MERGED" ||
                  !confirmed.headRepositoryNameWithOwner
                )
                  throw new Error(
                    "The pull request merge is not confirmed for base updates",
                  );
                await completeBaseBranchUpdates(
                  { provider: "GITHUB", id: rule.worktreeId },
                  {
                    origin: `github.com/${confirmed.headRepositoryNameWithOwner.toLowerCase()}`,
                    branch: confirmed.headRefName,
                  },
                  this.worktrees,
                );
              }
              if (
                rule.moveTicketToDone &&
                rule.ticketKey &&
                !rule.ticketMovedAt
              ) {
                const ticketMovedAt = await completeMergeTicketFollowUp(
                  this.jira,
                  rule,
                );
                await prisma.worktreeAutoMerge.update({
                  where: { worktreeId: rule.worktreeId },
                  data: { ticketMovedAt, lastError: null },
                });
              }
              if (!rule.deleteWorktree) {
                await prisma.worktreeAutoMerge.update({
                  where: { worktreeId: rule.worktreeId },
                  data: { state: "COMPLETED", lastError: null },
                });
                return;
              }
              if (rule.worktree.primary) {
                throw new Error("The primary worktree cannot be deleted");
              }
              if (!rule.deleteJobId) {
                const pullRequest = await this.pullRequestState(rule);
                if (pullRequest.state !== "MERGED") {
                  throw new Error("The pull request is no longer merged");
                }
                if (
                  !pullRequest.headRepositoryNameWithOwner ||
                  rule.worktree.codebase.repository.canonicalOrigin.toLowerCase() !==
                    `github.com/${pullRequest.headRepositoryNameWithOwner.toLowerCase()}`
                ) {
                  throw new Error(
                    "The merged pull request head repository does not match the worktree",
                  );
                }
                if (pullRequest.headRefName !== rule.branch) {
                  throw new Error(
                    "The merged pull request branch does not match the Auto Merge rule",
                  );
                }
                if (rule.worktree.branch !== rule.branch) {
                  throw new Error(
                    "The worktree branch changed after Auto Merge completed",
                  );
                }
                if (
                  !rule.worktree.headSha ||
                  rule.worktree.headSha !== pullRequest.headRefOid
                ) {
                  throw new Error(
                    "The worktree HEAD does not match the merged pull request",
                  );
                }
                const job = await this.worktrees.deleteWorktree({
                  worktreeId: rule.worktreeId,
                  deleteRemoteBranch: false,
                  requireClean: true,
                  expectedBranch: rule.branch,
                  expectedHeadSha: pullRequest.headRefOid,
                  requestId: `auto-merge-${randomUUID()}`,
                });
                await prisma.worktreeAutoMerge.update({
                  where: { worktreeId: rule.worktreeId },
                  data: { deleteJobId: job.id, lastError: null },
                });
                return;
              }
              const job = await this.agentControl.getJob(rule.deleteJobId);
              if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return;
              if (job.status !== "SUCCEEDED") {
                throw new Error(
                  job.error || `Worktree deletion ${job.status.toLowerCase()}`,
                );
              }
              await prisma.worktreeAutoMerge.updateMany({
                where: { worktreeId: rule.worktreeId },
                data: { state: "COMPLETED", lastError: null },
              });
            } catch (error) {
              if (
                isCodebaseBusyError(error) ||
                (!rule.autoSync &&
                  rule.state !== "POST_MERGE" &&
                  rule.state !== "ACTION_REQUIRED" &&
                  isTransientMergeError(error))
              ) {
                if (!rule.autoSync && rule.state !== "POST_MERGE")
                  await prisma.worktreeAutoMerge.updateMany({
                    where: { worktreeId: rule.worktreeId },
                    data: {
                      state: "WAITING_REQUIREMENTS",
                      lastError:
                        error instanceof Error ? error.message : String(error),
                    },
                  });
                return;
              }
              if (
                rule.state === "ACTION_REQUIRED" &&
                rule.lastError === LEGACY_CODEBASE_BUSY_MESSAGE &&
                isTransientMergeError(error)
              )
                return;
              await prisma.worktreeAutoMerge.updateMany({
                where: { worktreeId: rule.worktreeId },
                data: {
                  state: "ACTION_REQUIRED",
                  lastError:
                    error instanceof Error ? error.message : String(error),
                },
              });
            } finally {
              this.worktrees.publishAutomationChange(
                rule.worktreeId,
                rule.worktree.codebaseId,
              );
            }
          },
          savedRule.worktreeId,
        ),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
