import "server-only";

import { randomUUID } from "node:crypto";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { getPrismaClient } from "@/data/prisma-client";
import type { GitLabMergeOperation } from "@/generated/prisma/client";
import {
  validateMergeFollowUps,
  completeMergeTicketFollowUp,
} from "@/services/worktrees/merge-follow-ups";
import type { WorktreesService } from "@/services/worktrees";
import type { JiraService } from "@/services/jira";
import type { AgentControlService } from "@/services/agent-control";
import { publishIntegrationConfiguration } from "@/services/integration-configuration-events";
import { GitLabRequestError, type GitLabService } from "./gitlab.service";
import type {
  GitLabMergeOptions,
  GitLabMergeOperationView,
  GitLabMergeRequestView,
  GitLabMergeResult,
  SubmitGitLabMergeRequestMergeInput,
} from "./types";

const ACTIVE_STATES = ["PREPARING", "WAITING", "POST_MERGE"];
const TERMINAL_JOBS = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export function gitLabMergeOperationView(
  row: GitLabMergeOperation,
): GitLabMergeOperationView {
  return {
    id: row.id,
    state: row.state,
    autoMerge: row.autoMerge,
    worktreeId: row.worktreeId,
    ticketKey: row.ticketKey,
    lastError: row.lastError,
    mergeConfirmedAt: row.mergeConfirmedAt?.toISOString() ?? null,
    ticketMovedAt: row.ticketMovedAt?.toISOString() ?? null,
    worktreeDeletedAt: row.worktreeDeletedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function gitLabMergeBlocker(
  mr: GitLabMergeRequestView,
  permitted: boolean,
  automatic = false,
): string | null {
  if (mr.state !== "OPENED")
    return mr.state === "MERGED"
      ? "This merge request is already merged."
      : "This merge request is not open.";
  if (!permitted) return "Your GitLab account cannot merge this request.";
  if (mr.draft) return "Mark this merge request ready before merging.";
  if (mr.hasConflicts) return "Resolve the merge conflicts first.";
  if (mr.mergeWhenPipelineSucceeds) return "Auto-merge is already enabled.";
  const status = mr.detailedMergeStatus;
  if (status === "mergeable") return null;
  const reasons: Record<string, string> = {
    checking: "GitLab is checking merge readiness. Refresh to try again.",
    unchecked: "GitLab has not finished checking merge readiness.",
    approvals_syncing: "GitLab is updating approvals. Refresh to try again.",
    ci_still_running: "The pipeline is still running.",
    ci_must_pass: "The required pipeline must pass.",
    not_approved: "Required approvals are missing.",
    requested_changes: "A reviewer requested changes.",
    discussions_not_resolved: "Resolve the blocking discussions first.",
    conflict: "Resolve the merge conflicts first.",
    need_rebase: "Rebase the source branch before merging.",
    draft_status: "Mark this merge request ready before merging.",
    not_open: "This merge request is not open.",
    merge_time: "The scheduled merge time has not arrived.",
    blocked_status: "GitLab merge requirements are not yet satisfied.",
    policies_denied: "A project policy blocks this merge.",
  };
  if (
    automatic &&
    [
      "ci_still_running",
      "ci_must_pass",
      "not_approved",
      "discussions_not_resolved",
      "merge_time",
      "blocked_status",
    ].includes(status)
  )
    return null;
  return (
    reasons[status] ??
    "GitLab has not confirmed that this request can merge. Open it in GitLab for details."
  );
}

/** Coordinates native GitLab merging; it never performs a local merge or bypasses project rules. */
export class GitLabMergeService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly gitlab: GitLabService,
    private readonly worktrees: WorktreesService,
    private readonly jira: JiraService,
    private readonly agents: AgentControlService,
  ) {
    gitlab.setMergeCoordinator(this);
  }

  startRuntime() {
    this.wake();
  }

  wake() {
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reconcile(), 0);
    this.timer.unref();
  }

  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, next);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }

  private async instance() {
    const settings = await this.gitlab.getSettings();
    if (!settings.configured || !settings.baseUrl)
      throw new Error("GitLab is not configured.");
    return settings.baseUrl;
  }

  private async record(projectId: string, iid: number) {
    const instanceUrl = await this.instance();
    return (await getPrismaClient()).gitLabMergeOperation.findUnique({
      where: { instanceUrl_projectId_iid: { instanceUrl, projectId, iid } },
    });
  }

  async operation(projectId: string, iid: number) {
    const row = await this.record(projectId, iid);
    return row ? gitLabMergeOperationView(row) : null;
  }

  private async context(
    mr: GitLabMergeRequestView,
    worktreeId?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const [project, source] = await Promise.all([
      this.gitlab.mergeProject(mr.projectId),
      mr.sourceProjectId
        ? this.gitlab.mergeProject(mr.sourceProjectId).catch(() => null)
        : Promise.resolve(null),
    ]);
    const sourceOrigin = source
      ? normalizeGitOrigin(source.web_url).canonicalOrigin
      : null;
    const worktree = sourceOrigin
      ? await prisma.worktree.findFirst({
          where: {
            ...(worktreeId ? { id: worktreeId } : {}),
            missingAt: null,
            branch: mr.sourceBranch,
            codebase: { repository: { canonicalOrigin: sourceOrigin } },
          },
          orderBy: { updatedAt: "desc" },
          include: { codebase: { include: { repository: true } } },
        })
      : null;
    if (worktreeId && !worktree)
      throw new Error(
        "The worktree no longer matches the merge request source project and branch.",
      );
    const branchTicket = worktree
      ? await this.worktrees.ticketKeyForWorktree(worktree.id)
      : null;
    const ticketKey =
      mr.title.match(/\b([A-Z][A-Z0-9_]*-\d+)\b/)?.[1] ??
      branchTicket ??
      mr.sourceBranch.match(/\b([A-Z][A-Z0-9_]*-\d+)\b/)?.[1] ??
      null;
    const ticketProject = ticketKey
      ? await prisma.jiraProject.findUnique({
          where: { key: ticketKey.split("-")[0]! },
          select: { doneStatusId: true },
        })
      : null;
    return {
      projectPath: project.path_with_namespace,
      sourceOrigin,
      worktree,
      ticketKey,
      ticketDoneStatusConfigured: Boolean(ticketProject?.doneStatusId),
    };
  }

  async summary(mr: GitLabMergeRequestView) {
    const context = await this.context(mr);
    return {
      projectPath: context.projectPath,
      worktreeId: context.worktree?.id ?? null,
      worktreeHighlightColor: context.worktree?.highlightColor ?? null,
      ticketKey: context.ticketKey,
      mergeOperation: await this.operation(mr.projectId, mr.iid),
    };
  }

  async options(
    projectId: string,
    iid: number,
    worktreeId?: string | null,
  ): Promise<GitLabMergeOptions> {
    const {
      mr,
      project,
      canMerge,
      autoMergeUserId,
      removeSourceBranch,
      forceRemoveSourceBranch,
    } = await this.gitlab.mergeReadiness(projectId, iid);
    const [context, saved] = await Promise.all([
      this.context(mr, mr.state === "MERGED" ? null : worktreeId),
      this.record(projectId, iid),
    ]);
    const viewerId = (await this.gitlab.getSettings()).viewer?.id;
    const canCancel =
      canMerge ||
      Boolean(
        viewerId && (viewerId === mr.author.id || viewerId === autoMergeUserId),
      );
    const squashPolicy = project.squash_option ?? "default_off";
    const editable = squashPolicy !== "always" && squashPolicy !== "never";
    return {
      projectId,
      iid,
      title: mr.title,
      state: mr.state,
      sha: mr.sha,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      mergeMethod: project.merge_method ?? "merge",
      squashPolicy,
      squash: editable
        ? (saved?.squash ?? mr.squashOnMerge ?? squashPolicy === "default_on")
        : squashPolicy === "always",
      removeSourceBranch:
        forceRemoveSourceBranch ||
        (saved?.removeSourceBranch ?? removeSourceBranch),
      canRemoveSourceBranch:
        !forceRemoveSourceBranch && Boolean(mr.sourceProjectId),
      canMerge: !gitLabMergeBlocker(mr, canMerge),
      canAutoMerge: !gitLabMergeBlocker(mr, canMerge, true),
      canCancelAutoMerge:
        mr.state === "OPENED" && mr.mergeWhenPipelineSucceeds && canCancel,
      autoMergeEnabled: mr.mergeWhenPipelineSucceeds,
      mergeBlockedReason: gitLabMergeBlocker(mr, canMerge),
      autoMergeBlockedReason: gitLabMergeBlocker(mr, canMerge, true),
      mergeCommitMessage: saved?.mergeCommitMessage ?? null,
      squashCommitMessage: saved?.squashCommitMessage ?? null,
      worktreeId:
        mr.state === "MERGED"
          ? (saved?.worktreeId ?? null)
          : (context.worktree?.id ?? null),
      worktreeFolder:
        mr.state === "MERGED"
          ? (saved?.worktreeFolder ?? null)
          : (context.worktree?.folder ?? null),
      canDeleteWorktree:
        mr.state === "OPENED" &&
        Boolean(context.worktree && !context.worktree.primary),
      ticketKey: context.ticketKey,
      ticketDoneStatusConfigured: context.ticketDoneStatusConfigured,
      defaultMoveTicketToDone: saved?.moveTicketToDone ?? false,
      defaultDeleteWorktree: saved?.deleteWorktree ?? false,
      operation: saved ? gitLabMergeOperationView(saved) : null,
    };
  }

  private async result(
    projectId: string,
    iid: number,
  ): Promise<GitLabMergeResult> {
    const [mergeRequest, operation] = await Promise.all([
      this.gitlab.mergeRequestState(projectId, iid),
      this.operation(projectId, iid),
    ]);
    return {
      mergeRequest,
      operation,
      postMergeError: operation?.mergeConfirmedAt ? operation.lastError : null,
    };
  }

  async submit(
    input: SubmitGitLabMergeRequestMergeInput,
  ): Promise<GitLabMergeResult> {
    const instanceUrl = await this.instance();
    return this.locked(
      `${instanceUrl}:${input.projectId}:${input.iid}`,
      async () => {
        const prisma = await getPrismaClient();
        const options = await this.options(
          input.projectId,
          input.iid,
          input.worktreeId,
        );
        const saved = await this.record(input.projectId, input.iid);
        if (
          saved?.mergeConfirmedAt ||
          (saved && ACTIVE_STATES.includes(saved.state))
        )
          return this.result(input.projectId, input.iid);
        if (!input.sha || input.sha !== options.sha)
          throw new Error(
            "The source commit changed. Refresh the merge sheet and review the new commit before merging.",
          );
        if (input.autoMerge ? !options.canAutoMerge : !options.canMerge)
          throw new Error(
            (input.autoMerge
              ? options.autoMergeBlockedReason
              : options.mergeBlockedReason) ??
              "GitLab cannot merge this request.",
          );
        const squash = input.squash ?? options.squash;
        if (
          (options.squashPolicy === "always" && !squash) ||
          (options.squashPolicy === "never" && squash)
        )
          throw new Error(
            "The squash option no longer matches project policy.",
          );
        validateMergeFollowUps(input, options, "merge request");
        const mr = await this.gitlab.mergeRequestState(
          input.projectId,
          input.iid,
        );
        const context = await this.context(mr, input.worktreeId);
        const removeSourceBranch = options.canRemoveSourceBranch
          ? (input.removeSourceBranch ?? options.removeSourceBranch)
          : options.removeSourceBranch;
        const data = {
          state: "PREPARING",
          sourceProjectId: mr.sourceProjectId ?? null,
          sourceOrigin: context.sourceOrigin,
          branch: mr.sourceBranch,
          sha: input.sha,
          autoMerge: input.autoMerge ?? false,
          squash,
          removeSourceBranch,
          mergeCommitMessage: input.mergeCommitMessage?.trim() || null,
          squashCommitMessage: input.squashCommitMessage?.trim() || null,
          worktreeId: options.worktreeId,
          worktreeFolder: options.worktreeFolder,
          deleteWorktree: input.deleteWorktree ?? false,
          moveTicketToDone: input.moveTicketToDone ?? false,
          ticketKey: options.ticketKey,
          mergeConfirmedAt: null,
          ticketMovedAt: null,
          worktreeDeletedAt: null,
          deleteJobId: null,
          deleteRequestId: null,
          lastError: null,
        };
        let row = await prisma.gitLabMergeOperation.upsert({
          where: {
            instanceUrl_projectId_iid: {
              instanceUrl,
              projectId: input.projectId,
              iid: input.iid,
            },
          },
          create: {
            id: randomUUID(),
            instanceUrl,
            projectId: input.projectId,
            iid: input.iid,
            ...data,
          },
          update: data,
        });
        try {
          const remote = await this.gitlab.mergeMergeRequestDirect({
            ...input,
            squash,
            removeSourceBranch,
          });
          row = await this.observe(row, remote);
        } catch (error) {
          // A timeout can occur after GitLab accepted the merge. Resolve from fresh state, never resubmit.
          try {
            row = await this.observe(
              row,
              await this.gitlab.mergeRequestState(input.projectId, input.iid),
            );
          } catch {
            row = await prisma.gitLabMergeOperation.update({
              where: { id: row.id },
              data: {
                lastError: String(
                  error instanceof Error ? error.message : error,
                ),
              },
            });
          }
          if (!row.mergeConfirmedAt && row.state !== "WAITING") {
            if (
              error instanceof GitLabRequestError &&
              error.statusCode &&
              error.statusCode >= 400 &&
              error.statusCode < 500 &&
              error.statusCode !== 429
            ) {
              await prisma.gitLabMergeOperation.update({
                where: { id: row.id },
                data: { state: "ACTION_REQUIRED", lastError: error.message },
              });
            }
            this.wake();
            throw error;
          }
        }
        if (row.mergeConfirmedAt) await this.followUps(row);
        this.changed(row);
        this.wake();
        return this.result(input.projectId, input.iid);
      },
    );
  }

  private changed(row: GitLabMergeOperation) {
    publishIntegrationConfiguration("gitlab");
    if (row.worktreeId) this.worktrees.publishAutomationChange(row.worktreeId);
  }

  private async observe(
    row: GitLabMergeOperation,
    mr: GitLabMergeRequestView,
  ): Promise<GitLabMergeOperation> {
    const prisma = await getPrismaClient();
    if (mr.state === "MERGED") {
      const matches = this.matchesReviewedSource(row, mr);
      return prisma.gitLabMergeOperation.update({
        where: { id: row.id },
        data: {
          state: !matches
            ? "ACTION_REQUIRED"
            : row.state === "COMPLETED"
              ? "COMPLETED"
              : "POST_MERGE",
          mergeConfirmedAt: row.mergeConfirmedAt ?? new Date(),
          lastError: matches
            ? null
            : "GitLab merged a different source project, branch or commit. The selected follow-ups require manual review.",
        },
      });
    }
    if (!this.matchesReviewedSource(row, mr)) {
      if (mr.mergeWhenPipelineSucceeds) {
        await this.gitlab.cancelAutoMergeDirect(row.projectId, row.iid);
        const fresh = await this.gitlab.mergeRequestState(
          row.projectId,
          row.iid,
        );
        if (fresh.state === "MERGED") return this.observe(row, fresh);
        if (fresh.mergeWhenPipelineSucceeds)
          throw new Error(
            "The source commit changed, but GitLab auto-merge is still enabled. Cancellation will be retried; open the merge request in GitLab to review its state.",
          );
      }
      return prisma.gitLabMergeOperation.update({
        where: { id: row.id },
        data: {
          state: "ACTION_REQUIRED",
          lastError:
            "The source commit changed. Review the new commit before enabling auto-merge again.",
        },
      });
    }
    if (mr.state !== "OPENED")
      return prisma.gitLabMergeOperation.update({
        where: { id: row.id },
        data: {
          state: "ACTION_REQUIRED",
          lastError: "The merge request closed without merging.",
        },
      });
    if (row.autoMerge && mr.mergeWhenPipelineSucceeds)
      return prisma.gitLabMergeOperation.update({
        where: { id: row.id },
        data: { state: "WAITING", lastError: null },
      });
    if (
      row.state === "PREPARING" &&
      Date.now() - row.updatedAt.getTime() < 120_000
    )
      return row;
    return prisma.gitLabMergeOperation.update({
      where: { id: row.id },
      data: {
        state: "ACTION_REQUIRED",
        lastError: row.autoMerge
          ? "GitLab auto-merge is no longer enabled. Review and enable it again."
          : "GitLab has not confirmed this merge. Refresh and review its state before retrying.",
      },
    });
  }

  private matchesReviewedSource(
    row: GitLabMergeOperation,
    mr: GitLabMergeRequestView,
  ) {
    return (
      row.sha === mr.sha &&
      row.branch === mr.sourceBranch &&
      row.sourceProjectId === (mr.sourceProjectId ?? null)
    );
  }

  private async followUps(row: GitLabMergeOperation) {
    const prisma = await getPrismaClient();
    if (!row.mergeConfirmedAt || row.state === "COMPLETED") return;
    try {
      const confirmed = await this.gitlab.mergeRequestState(
        row.projectId,
        row.iid,
      );
      if (
        confirmed.state !== "MERGED" ||
        !this.matchesReviewedSource(row, confirmed)
      ) {
        throw new Error(
          "GitLab merged a different source project, branch or commit. The selected follow-ups require manual review.",
        );
      }
      if (row.moveTicketToDone && row.ticketKey && !row.ticketMovedAt) {
        const ticketMovedAt = await completeMergeTicketFollowUp(this.jira, row);
        row = await prisma.gitLabMergeOperation.update({
          where: { id: row.id },
          data: { ticketMovedAt, lastError: null },
        });
      }
      if (row.deleteWorktree && !row.worktreeDeletedAt) {
        if (!row.worktreeId)
          throw new Error("The linked worktree is unavailable.");
        const worktreeId = row.worktreeId;
        if (!row.deleteJobId && row.deleteRequestId) {
          const existing = await prisma.agentJob.findFirst({
            where: {
              idempotencyKey: `worktree:delete:${row.deleteRequestId}:${row.worktreeId}`,
            },
            select: { id: true },
          });
          if (existing)
            row = await prisma.gitLabMergeOperation.update({
              where: { id: row.id },
              data: { deleteJobId: existing.id },
            });
        }
        if (!row.deleteJobId) {
          const [worktree, remote] = await Promise.all([
            prisma.worktree.findUnique({
              where: { id: worktreeId },
              include: { codebase: { include: { repository: true } } },
            }),
            this.gitlab.mergeRequestState(row.projectId, row.iid),
          ]);
          if (!worktree || worktree.primary || worktree.missingAt)
            throw new Error("The linked non-primary worktree is unavailable.");
          if (
            remote.state !== "MERGED" ||
            remote.sha !== row.sha ||
            remote.sourceProjectId !== row.sourceProjectId ||
            remote.sourceBranch !== row.branch ||
            !row.sourceOrigin ||
            worktree.codebase.repository.canonicalOrigin !== row.sourceOrigin ||
            worktree.branch !== row.branch ||
            worktree.headSha !== row.sha
          )
            throw new Error(
              "The worktree no longer matches the merged source project, branch and commit.",
            );
          const requestId =
            row.deleteRequestId ?? `gitlab-merge-${row.id}-${randomUUID()}`;
          if (!row.deleteRequestId)
            row = await prisma.gitLabMergeOperation.update({
              where: { id: row.id },
              data: { deleteRequestId: requestId },
            });
          const job = await this.worktrees.deleteWorktree({
            worktreeId: worktree.id,
            deleteRemoteBranch: false,
            requireClean: true,
            expectedBranch: row.branch,
            expectedHeadSha: row.sha,
            requestId,
          });
          row = await prisma.gitLabMergeOperation.update({
            where: { id: row.id },
            data: { deleteJobId: job.id, lastError: null },
          });
        }
        const job = await this.agents.getJob(row.deleteJobId!);
        if (!job || !TERMINAL_JOBS.has(job.status)) return;
        if (job.status !== "SUCCEEDED")
          throw new Error(job.error || "Worktree cleanup failed.");
        row = await prisma.gitLabMergeOperation.update({
          where: { id: row.id },
          data: { worktreeDeletedAt: new Date() },
        });
      }
      await prisma.gitLabMergeOperation.update({
        where: { id: row.id },
        data: { state: "COMPLETED", lastError: null },
      });
    } catch (error) {
      await prisma.gitLabMergeOperation.update({
        where: { id: row.id },
        data: {
          state: "ACTION_REQUIRED",
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.changed(row);
    }
  }

  async cancel(projectId: string, iid: number): Promise<GitLabMergeResult> {
    const instanceUrl = await this.instance();
    return this.locked(`${instanceUrl}:${projectId}:${iid}`, async () => {
      let row = await this.record(projectId, iid);
      let failure: unknown;
      try {
        await this.gitlab.cancelAutoMergeDirect(projectId, iid);
      } catch (error) {
        failure = error;
      }
      const mr = await this.gitlab.mergeRequestState(projectId, iid);
      if (mr.state === "MERGED" && row) {
        row = await this.observe(row, mr);
        await this.followUps(row);
      } else if (mr.mergeWhenPipelineSucceeds)
        throw failure ?? new Error("GitLab auto-merge is still enabled.");
      else if (row)
        await (
          await getPrismaClient()
        ).gitLabMergeOperation.update({
          where: { id: row.id },
          data: { state: "CANCELED", lastError: null },
        });
      if (row) this.changed(row);
      return this.result(projectId, iid);
    });
  }

  async retryFollowUps(
    projectId: string,
    iid: number,
  ): Promise<GitLabMergeResult> {
    const instanceUrl = await this.instance();
    return this.locked(`${instanceUrl}:${projectId}:${iid}`, async () => {
      let row = await this.record(projectId, iid);
      if (!row?.mergeConfirmedAt)
        throw new Error(
          "Follow-ups can only be retried after a confirmed merge.",
        );
      const prisma = await getPrismaClient();
      const job = row.deleteJobId
        ? await this.agents.getJob(row.deleteJobId)
        : null;
      row = await prisma.gitLabMergeOperation.update({
        where: { id: row.id },
        data: {
          state: "POST_MERGE",
          lastError: null,
          ...(job && TERMINAL_JOBS.has(job.status) && job.status !== "SUCCEEDED"
            ? { deleteJobId: null, deleteRequestId: null }
            : {}),
        },
      });
      await this.followUps(row);
      this.wake();
      return this.result(projectId, iid);
    });
  }

  async reconcile() {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      const prisma = await getPrismaClient();
      const rows = await prisma.gitLabMergeOperation.findMany({
        where: { state: { in: ACTIVE_STATES } },
      });
      if (!rows.length) return;
      const instanceUrl = await this.instance().catch(() => null);
      for (const row of rows)
        await this.locked(
          `${row.instanceUrl}:${row.projectId}:${row.iid}`,
          async () => {
            // Reload after acquiring the lock: a user action may have completed while we waited.
            const current = await prisma.gitLabMergeOperation.findUnique({
              where: { id: row.id },
            });
            if (!current || !ACTIVE_STATES.includes(current.state)) return;
            if (current.instanceUrl !== instanceUrl) {
              await prisma.gitLabMergeOperation.update({
                where: { id: row.id },
                data: {
                  state: "ACTION_REQUIRED",
                  lastError:
                    "The configured GitLab instance or credentials changed.",
                },
              });
              return;
            }
            try {
              const updated = await this.observe(
                current,
                await this.gitlab.mergeRequestState(row.projectId, row.iid),
              );
              if (updated.mergeConfirmedAt) await this.followUps(updated);
            } catch (error) {
              await prisma.gitLabMergeOperation.update({
                where: { id: row.id },
                data: {
                  lastError:
                    error instanceof Error ? error.message : String(error),
                },
              });
            } finally {
              this.changed(current);
            }
          },
        );
    } catch (error) {
      console.error(
        "GitLab merge reconciliation failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => void this.reconcile(),
        this.rerun ? 0 : 60_000,
      );
      this.timer.unref();
      this.rerun = false;
    }
  }
}
