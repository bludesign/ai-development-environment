import "server-only";

import { randomUUID } from "node:crypto";

import { WORKTREE_AUTO_SYNC_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";

import type { GitHubMergeMethod } from "@/services/github";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { PollingService } from "@/services/polling";
import type { WorkflowsService } from "@/services/workflows";
import type { AgentControlService } from "@/services/agent-control";
import { getPrismaClient } from "@/data/prisma-client";

import type { WorktreesService } from "./worktrees.service";

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

function syncView(rule: {
  worktreeId: string;
  state: string;
  conflictWorkflowId: string | null;
  conflictWorkflowChoice: string | null;
  lastError: string | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
}) {
  return {
    worktreeId: rule.worktreeId,
    state: rule.state,
    conflictWorkflowId: rule.conflictWorkflowId,
    conflictWorkflowChoice: rule.conflictWorkflowChoice,
    lastError: rule.lastError,
    lastSyncedAt: rule.lastSyncedAt?.toISOString() ?? null,
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function mergeView(rule: {
  worktreeId: string;
  state: string;
  repositoryNameWithOwner: string;
  pullRequestNumber: number;
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
    mergeMethod: rule.mergeMethod as GitHubMergeMethod,
    updatedAt: rule.updatedAt.toISOString(),
  };
}

export class WorktreeAutomationService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;

  constructor(
    private readonly worktrees: WorktreesService,
    private readonly github: GitHubService,
    private readonly jira: JiraService,
    private readonly workflows: WorkflowsService,
    private readonly agentControl: AgentControlService,
    private readonly polling?: PollingService,
  ) {
    this.agentControl.registerCompletionObserver(async (job) => {
      if (job.kind === WORKTREE_AUTO_SYNC_JOB_KIND) this.changed();
    });
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
        codebase: { select: { repositoryId: true } },
      },
    });
    if (!worktree?.branch) throw new Error("Auto Sync requires a branch");
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

  async configureAutoMerge(input: {
    worktreeId: string;
    repositoryNameWithOwner: string;
    pullRequestNumber: number;
    method: GitHubMergeMethod;
    commitHeadline: string;
    commitBody: string;
    authorEmail?: string | null;
    deleteWorktree: boolean;
    moveTicketToDone: boolean;
  }) {
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
            repository: { select: { canonicalOrigin: true } },
          },
        },
      },
    });
    if (!worktree?.branch) throw new Error("Auto Merge requires a branch");
    if (input.deleteWorktree && worktree.primary) {
      throw new Error("The primary worktree cannot be deleted after merge");
    }
    const existing = await prisma.worktreeAutoMerge.findUnique({
      where: { worktreeId: worktree.id },
    });
    const ticketKey = await this.worktrees.ticketKeyForWorktree(worktree.id);
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
    const retargeting = Boolean(
      existing &&
      (existing.repositoryNameWithOwner.toLowerCase() !==
        input.repositoryNameWithOwner.toLowerCase() ||
        existing.pullRequestNumber !== input.pullRequestNumber),
    );
    let previousAutoMergeDisabled = false;
    let newAutoMergeAttempted = false;
    try {
      if (existing && retargeting) {
        const previousRepository = repositoryParts(
          existing.repositoryNameWithOwner,
        );
        const previousState = await this.github.pullRequestAutomationState(
          previousRepository.owner,
          previousRepository.name,
          existing.pullRequestNumber,
        );
        if (previousState.state === "OPEN" && previousState.autoMergeEnabled) {
          await this.github.disablePullRequestAutoMerge({
            ...previousRepository,
            number: existing.pullRequestNumber,
          });
          previousAutoMergeDisabled = true;
        }
      }
      newAutoMergeAttempted = true;
      await this.github.enablePullRequestAutoMerge({
        ...repository,
        number: input.pullRequestNumber,
        method: input.method,
        commitHeadline: input.commitHeadline,
        commitBody: input.commitBody,
        authorEmail: input.authorEmail,
      });
      const rule = await prisma.worktreeAutoMerge.upsert({
        where: { worktreeId: worktree.id },
        create: {
          worktreeId: worktree.id,
          repositoryNameWithOwner: input.repositoryNameWithOwner,
          pullRequestNumber: input.pullRequestNumber,
          branch: worktree.branch,
          mergeMethod: input.method,
          commitHeadline: input.commitHeadline.trim(),
          commitBody: input.commitBody,
          authorEmail: input.authorEmail?.trim() || null,
          deleteWorktree: input.deleteWorktree,
          moveTicketToDone: input.moveTicketToDone,
          ticketKey,
        },
        update: {
          state: "ACTIVE",
          repositoryNameWithOwner: input.repositoryNameWithOwner,
          pullRequestNumber: input.pullRequestNumber,
          branch: worktree.branch,
          mergeMethod: input.method,
          commitHeadline: input.commitHeadline.trim(),
          commitBody: input.commitBody,
          authorEmail: input.authorEmail?.trim() || null,
          deleteWorktree: input.deleteWorktree,
          moveTicketToDone: input.moveTicketToDone,
          ticketKey,
          ticketMovedAt: null,
          deleteJobId: null,
          lastError: null,
        },
      });
      this.worktrees.publishAutomationChange(worktree.id, worktree.codebaseId);
      this.changed();
      return mergeView(rule);
    } catch (error) {
      if (newAutoMergeAttempted) {
        await this.github
          .disablePullRequestAutoMerge({
            ...repository,
            number: input.pullRequestNumber,
          })
          .catch(() => null);
      }
      if (existing && (previousAutoMergeDisabled || !retargeting)) {
        const previousRepository = repositoryParts(
          existing.repositoryNameWithOwner,
        );
        await this.github
          .enablePullRequestAutoMerge({
            ...previousRepository,
            number: existing.pullRequestNumber,
            method: existing.mergeMethod as GitHubMergeMethod,
            commitHeadline: existing.commitHeadline,
            commitBody: existing.commitBody,
            authorEmail: existing.authorEmail,
          })
          .catch(() => null);
      }
      throw error;
    }
  }

  async cancelAutoMerge(worktreeId: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const rule = await prisma.worktreeAutoMerge.findUnique({
      where: { worktreeId },
    });
    if (!rule) return false;
    const repository = repositoryParts(rule.repositoryNameWithOwner);
    const state = await this.github.pullRequestAutomationState(
      repository.owner,
      repository.name,
      rule.pullRequestNumber,
    );
    if (state.state === "OPEN" && state.autoMergeEnabled) {
      await this.github.disablePullRequestAutoMerge({
        ...repository,
        number: rule.pullRequestNumber,
      });
    }
    await prisma.worktreeAutoMerge.delete({ where: { worktreeId } });
    this.worktrees.publishAutomationChange(worktreeId);
    return true;
  }

  async retryAutoMerge(worktreeId: string) {
    const prisma = await getPrismaClient();
    const existing = await prisma.worktreeAutoMerge.findUniqueOrThrow({
      where: { worktreeId },
    });
    const repository = repositoryParts(existing.repositoryNameWithOwner);
    const pullRequest = await this.github.pullRequestAutomationState(
      repository.owner,
      repository.name,
      existing.pullRequestNumber,
    );
    const state = pullRequest.state === "MERGED" ? "POST_MERGE" : "ACTIVE";
    const rule = await prisma.worktreeAutoMerge.update({
      where: { worktreeId },
      data: { state, lastError: null, deleteJobId: null },
    });
    this.worktrees.publishAutomationChange(worktreeId);
    this.changed();
    return mergeView(rule);
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
          await this.reconcileAutoSync();
          await this.reconcileAutoMerge();
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

  private async reconcileAutoSync(): Promise<void> {
    const prisma = await getPrismaClient();
    const rules = await prisma.worktreeAutoSync.findMany({
      where: { state: { in: ["ACTIVE", "SYNCING", "RESOLVING"] } },
      include: { worktree: { select: { codebaseId: true } } },
    });
    for (const rule of rules) {
      try {
        const current = await prisma.worktree.findUnique({
          where: { id: rule.worktreeId },
          select: { branch: true },
        });
        if (current?.branch !== rule.branch) {
          throw new Error(
            "Auto Sync paused because the worktree branch changed",
          );
        }
        if (rule.state === "ACTIVE") {
          const job = await this.worktrees.createAutoSyncJob(
            rule.worktreeId,
            "SYNC",
            rule.branch,
            randomUUID(),
          );
          await prisma.worktreeAutoSync.update({
            where: { worktreeId: rule.worktreeId },
            data: { state: "SYNCING", activeJobId: job.id, lastError: null },
          });
          continue;
        }
        if (rule.state === "RESOLVING") {
          if (!rule.workflowRunId) {
            throw new Error("The conflict workflow run is missing");
          }
          const run = await this.workflows.run(rule.workflowRunId);
          if (!run || !TERMINAL_WORKFLOW_STATUSES.has(run.status)) continue;
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
            },
          });
          continue;
        }
        if (!rule.activeJobId) throw new Error("The Auto Sync job is missing");
        const job = await this.agentControl.getJob(rule.activeJobId);
        if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) continue;
        if (job.status !== "SUCCEEDED") {
          throw new Error(job.error || `Auto Sync ${job.status.toLowerCase()}`);
        }
        const outcome = resultOutcome(job.resultJson);
        if (outcome === "CONFLICT") {
          if (!rule.conflictWorkflowId) {
            throw new Error(
              "Auto Sync paused because the rebase has merge conflicts",
            );
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
            },
          });
          continue;
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
            ...(outcome === "SYNCED" ? { lastSyncedAt: new Date() } : {}),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transient =
          /offline|busy|already has an active job|temporarily/i.test(message);
        await prisma.worktreeAutoSync.updateMany({
          where: { worktreeId: rule.worktreeId },
          data: {
            state: transient ? "ACTIVE" : "PAUSED",
            activeJobId: null,
            workflowRunId: null,
            lastError: message,
          },
        });
      } finally {
        this.worktrees.publishAutomationChange(
          rule.worktreeId,
          rule.worktree.codebaseId,
        );
      }
    }
  }

  private async reconcileAutoMerge(): Promise<void> {
    const prisma = await getPrismaClient();
    const rules = await prisma.worktreeAutoMerge.findMany({
      where: { state: { in: ["ACTIVE", "POST_MERGE"] } },
      include: {
        worktree: {
          select: {
            codebaseId: true,
            branch: true,
            headSha: true,
            primary: true,
          },
        },
      },
    });
    for (const rule of rules) {
      try {
        const repository = repositoryParts(rule.repositoryNameWithOwner);
        if (rule.state === "ACTIVE") {
          const pullRequest = await this.github.pullRequestAutomationState(
            repository.owner,
            repository.name,
            rule.pullRequestNumber,
          );
          if (pullRequest.state === "MERGED") {
            await prisma.worktreeAutoMerge.update({
              where: { worktreeId: rule.worktreeId },
              data: { state: "POST_MERGE", lastError: null },
            });
            this.rerunRequested = true;
          } else if (pullRequest.state !== "OPEN") {
            throw new Error("The pull request closed without merging");
          } else if (!pullRequest.autoMergeEnabled) {
            throw new Error("GitHub Auto Merge is no longer enabled");
          }
          continue;
        }
        if (rule.moveTicketToDone && rule.ticketKey && !rule.ticketMovedAt) {
          await this.jira.transitionTicketToConfiguredDone(rule.ticketKey);
          await prisma.worktreeAutoMerge.update({
            where: { worktreeId: rule.worktreeId },
            data: { ticketMovedAt: new Date(), lastError: null },
          });
        }
        if (!rule.deleteWorktree) {
          await prisma.worktreeAutoMerge.update({
            where: { worktreeId: rule.worktreeId },
            data: { state: "COMPLETED", lastError: null },
          });
          continue;
        }
        if (rule.worktree.primary) {
          throw new Error("The primary worktree cannot be deleted");
        }
        if (!rule.deleteJobId) {
          const pullRequest = await this.github.pullRequestAutomationState(
            repository.owner,
            repository.name,
            rule.pullRequestNumber,
          );
          if (pullRequest.state !== "MERGED") {
            throw new Error("The pull request is no longer merged");
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
          continue;
        }
        const job = await this.agentControl.getJob(rule.deleteJobId);
        if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) continue;
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
        await prisma.worktreeAutoMerge.updateMany({
          where: { worktreeId: rule.worktreeId },
          data: {
            state: "ACTION_REQUIRED",
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        this.worktrees.publishAutomationChange(
          rule.worktreeId,
          rule.worktree.codebaseId,
        );
      }
    }
  }
}
