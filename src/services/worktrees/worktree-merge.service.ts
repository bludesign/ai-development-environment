import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { validGitBranchName } from "@ai-development-environment/agent-contract/worktrees";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma, WorktreeMergeItem } from "@/generated/prisma/client";
import { isDefaultWorktreeBranch } from "@/lib/default-branches";
import type {
  GitHubPullRequestMergeInput,
  GitHubPullRequestMergeOptions,
  GitHubService,
} from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { GitLabMergeService } from "@/services/gitlab/gitlab-merge.service";
import type {
  GitLabMergeOptions,
  GitLabMergeRequestView,
  SubmitGitLabMergeRequestMergeInput,
} from "@/services/gitlab/types";
import { recoverMergeReservations } from "@/services/operation-locks/operation-locks.service";
import type { PollingService } from "@/services/polling";
import {
  MANAGED_MERGE_STATES,
  MergeSyncNotSubmittedError,
} from "./merge-branch-sync";
import {
  isUnknownMergeOutcome,
  type BulkMergeReview,
} from "./bulk-merge-review";
import type { WorktreeAutomationService } from "./worktree-automation.service";

const ACTIVE_GITHUB = ["ACTIVE", "POST_MERGE", ...MANAGED_MERGE_STATES];
const POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
const POLLING_ID = "server:worktree-bulk-merge";
const MERGE_CONFIRMATION_MS = 120_000;
const ACTIVE_REQUEST = "A Bulk Merge submission already owns this request.";
const targetInclude = {
  codebase: { include: { repository: true, agent: true } },
  pullRequest: true,
  gitLabMergeRequest: true,
} satisfies Prisma.WorktreeInclude;
const batchInclude = {
  items: { orderBy: { position: "asc" } },
} satisfies Prisma.WorktreeMergeBatchInclude;
type Target = Prisma.WorktreeGetPayload<{ include: typeof targetInclude }>;
type Batch = Prisma.WorktreeMergeBatchGetPayload<{
  include: typeof batchInclude;
}>;
type Scope = { appId?: string | null; agentId?: string | null };
type Settings =
  | { provider: "GITHUB"; input: GitHubPullRequestMergeInput }
  | {
      provider: "GITLAB";
      instanceUrl: string;
      input: SubmitGitLabMergeRequestMergeInput;
    };
type MergeItemInput = {
  worktreeId: string;
  requestKey: string;
  reviewedHeadSha: string;
  reviewedTargetBranch: string;
  github?: GitHubPullRequestMergeInput | null;
  gitlab?: SubmitGitLabMergeRequestMergeInput | null;
};
export type StartWorktreeMergeBatchInput = Scope & {
  requestId: string;
  items: MergeItemInput[];
};
type Request = {
  provider: Settings["provider"];
  requestKey: string;
  requestNumber: number;
  requestTitle: string;
  requestUrl: string;
  repositoryNameWithOwner: string | null;
  projectId: string | null;
};
type Options = {
  reviewedHeadSha: string | null;
  reviewedTargetBranch: string | null;
  blockedReason: string | null;
  githubOptions: GitHubPullRequestMergeOptions | null;
  gitlabOptions: GitLabMergeOptions | null;
};

function scopeWhere(scope: Scope): Prisma.WorktreeWhereInput {
  return {
    codebase: {
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.appId
        ? { repository: { apps: { some: { appId: scope.appId } } } }
        : {}),
    },
  };
}

function githubKey(repository: string, number: number) {
  return JSON.stringify(["GITHUB", repository.toLowerCase(), number]);
}

function gitlabKey(instance: string | null, projectId: string, iid: number) {
  return JSON.stringify(["GITLAB", instance, projectId, iid]);
}

function linkedRequest(
  target: Target,
  instance: string | null,
): Request | null {
  const gitlab = target.gitLabMergeRequest;
  if (gitlab?.state === "OPENED" && gitlab.sourceBranch === target.branch)
    return {
      provider: "GITLAB",
      requestKey: gitlabKey(instance, gitlab.projectId, gitlab.iid),
      requestNumber: gitlab.iid,
      requestTitle: gitlab.title,
      requestUrl: gitlab.webUrl,
      repositoryNameWithOwner: null,
      projectId: gitlab.projectId,
    };
  const github = target.pullRequest;
  return github?.state === "OPEN" && github.headRefName === target.branch
    ? {
        provider: "GITHUB",
        requestKey: githubKey(github.repositoryNameWithOwner, github.number),
        requestNumber: github.number,
        requestTitle: github.title,
        requestUrl: github.url,
        repositoryNameWithOwner: github.repositoryNameWithOwner,
        projectId: null,
      }
    : null;
}

function targetBlocked(target: Target): string | null {
  if (
    target.missingAt ||
    target.availability !== "AVAILABLE" ||
    target.codebase.availability !== "AVAILABLE" ||
    !target.branch
  )
    return "The linked worktree is unavailable.";
  if (isDefaultWorktreeBranch(target))
    return "Default branches cannot use Bulk Merge.";
  if (target.rebaseInProgress || target.hasConflicts)
    return "Resolve the worktree conflicts or finish the rebase first.";
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blocked(reason: string): Options {
  return {
    reviewedHeadSha: null,
    reviewedTargetBranch: null,
    blockedReason: reason,
    githubOptions: null,
    gitlabOptions: null,
  };
}

function batchView(batch: Batch) {
  return {
    id: batch.id,
    appId: batch.appId,
    agentId: batch.agentId,
    status: batch.status,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    items: batch.items.map((item) => ({
      id: item.id,
      worktreeId: item.worktreeId,
      repositoryName: item.repositoryName,
      agentName: item.agentName,
      branch: item.branch,
      folder: item.folder,
      provider: item.provider,
      requestKey: item.requestKey,
      requestNumber: item.requestNumber,
      requestTitle: item.requestTitle,
      requestUrl: item.requestUrl,
      status: item.status,
      error: item.error,
      postMergeError: item.postMergeError,
      startedAt: item.startedAt?.toISOString() ?? null,
      finishedAt: item.finishedAt?.toISOString() ?? null,
    })),
  };
}

function normalizedSettings(item: MergeItemInput): Settings {
  if (Boolean(item.github) === Boolean(item.gitlab))
    throw new Error("Choose exactly one provider for each Bulk Merge row.");
  if (
    !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(item.reviewedHeadSha) ||
    !validGitBranchName(item.reviewedTargetBranch)
  )
    throw new Error(
      "Review the source and target before submitting each merge.",
    );
  if (item.github) {
    const { owner, name, number } = item.github;
    if (
      item.requestKey !== githubKey(`${owner}/${name}`, number) ||
      (item.github.worktreeId && item.github.worktreeId !== item.worktreeId)
    )
      throw new Error(
        "The selected GitHub request does not match the reviewed row.",
      );
    return {
      provider: "GITHUB",
      input: {
        ...item.github,
        owner: owner.toLowerCase(),
        name: name.toLowerCase(),
        worktreeId: item.worktreeId,
      },
    };
  }
  const gitlab = item.gitlab!;
  let key: unknown;
  try {
    key = JSON.parse(item.requestKey);
  } catch {
    throw new Error(
      "The selected GitLab request does not match the reviewed row.",
    );
  }
  const instanceUrl =
    Array.isArray(key) && typeof key[1] === "string" ? key[1] : null;
  if (
    !instanceUrl ||
    item.requestKey !== gitlabKey(instanceUrl, gitlab.projectId, gitlab.iid) ||
    gitlab.sha !== item.reviewedHeadSha ||
    (gitlab.worktreeId && gitlab.worktreeId !== item.worktreeId)
  )
    throw new Error(
      "The selected GitLab request does not match the reviewed row.",
    );
  if (
    gitlab.autoMerge ||
    gitlab.autoSync ||
    gitlab.conflictWorkflowId ||
    gitlab.conflictWorkflowChoice
  )
    throw new Error("Bulk Merge only submits immediate merges.");
  return {
    provider: "GITLAB",
    instanceUrl,
    input: {
      ...gitlab,
      autoMerge: false,
      autoSync: false,
      worktreeId: item.worktreeId,
    },
  };
}

function fingerprint(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, candidate: unknown) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? Object.fromEntries(
          Object.entries(candidate).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : candidate,
  );
  return createHash("sha256").update(serialized).digest("hex");
}

async function activeRequests(requestKeys: string[]) {
  if (!requestKeys.length) return new Set<string>();
  const rows = await (
    await getPrismaClient()
  ).worktreeMergeItem.findMany({
    where: {
      activeRequestKey: { in: requestKeys },
    },
    select: { requestKey: true },
  });
  return new Set(rows.map(({ requestKey }) => requestKey));
}

export class WorktreeMergeService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private running = false;
  private rerun = false;

  constructor(
    private readonly github: GitHubService,
    private readonly gitlab: GitLabService,
    private readonly githubMerges: WorktreeAutomationService,
    private readonly gitlabMerges: GitLabMergeService,
    private readonly polling?: PollingService,
  ) {}

  startRuntime() {
    if (this.started) return;
    this.started = true;
    this.polling?.register({
      id: POLLING_ID,
      kind: "WORKTREE_AUTOMATION",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: IDLE_POLL_MS / 1000,
      details: { operation: "BULK_MERGE" },
    });
    this.wake();
  }

  private wake() {
    if (!this.started) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reconcile(), 0);
    this.timer.unref();
  }

  private async gitlabInstance() {
    const settings = await this.gitlab.getSettings();
    return settings.configured ? settings.baseUrl : null;
  }

  private async options(target: Target, request: Request): Promise<Options> {
    const unavailable = targetBlocked(target);
    if (unavailable) return blocked(unavailable);
    if (request.provider === "GITLAB") {
      const options = await this.gitlabMerges.options(
        request.projectId!,
        request.requestNumber,
        target.id,
      );
      const active =
        options.operation &&
        [
          "PREPARING",
          "WAITING",
          "POST_MERGE",
          ...MANAGED_MERGE_STATES,
        ].includes(options.operation.state);
      return {
        reviewedHeadSha: options.sha,
        reviewedTargetBranch: options.targetBranch,
        blockedReason:
          options.worktreeId !== target.id
            ? "The request no longer matches this worktree."
            : active || options.autoMergeEnabled
              ? "Auto Merge or another merge is already active for this request."
              : options.canMerge
                ? null
                : (options.mergeBlockedReason ??
                  "GitLab cannot merge this request."),
        githubOptions: null,
        gitlabOptions: options,
      };
    }
    const repository = request.repositoryNameWithOwner!;
    const [owner, name] = repository.split("/") as [string, string];
    const active = (
      await (
        await getPrismaClient()
      ).worktreeAutoMerge.findMany({
        where: {
          pullRequestNumber: request.requestNumber,
          state: { in: ACTIVE_GITHUB },
        },
        select: { repositoryNameWithOwner: true },
      })
    ).some(
      ({ repositoryNameWithOwner }) =>
        repositoryNameWithOwner.toLowerCase() === repository.toLowerCase(),
    );
    const options = await this.githubMerges.pullRequestMergeOptions(
      owner,
      name,
      request.requestNumber,
      "WORKTREE_AUTOMATION",
      target.id,
    );
    return {
      reviewedHeadSha: options.headRefOid,
      reviewedTargetBranch: options.baseRefName ?? null,
      blockedReason:
        options.worktreeId !== target.id
          ? "The request no longer matches this worktree."
          : active ||
              options.autoMergeEnabled ||
              ACTIVE_GITHUB.includes(options.autoMergeOperation?.state ?? "")
            ? "Auto Merge or another merge is already active for this request."
            : options.canMerge && options.baseRefName
              ? null
              : (options.blockedReason ?? "GitHub cannot merge this request."),
      githubOptions: options,
      gitlabOptions: null,
    };
  }

  async candidates(scope: Scope) {
    const prisma = await getPrismaClient();
    const targets = await prisma.worktree.findMany({
      where: {
        ...scopeWhere(scope),
        missingAt: null,
        OR: [
          { pullRequest: { state: "OPEN" } },
          { gitLabMergeRequest: { state: "OPENED" } },
        ],
      },
      include: targetInclude,
      orderBy: [
        { codebase: { repository: { name: "asc" } } },
        { codebase: { agent: { name: "asc" } } },
        { branch: "asc" },
        { id: "asc" },
      ],
    });
    const instance = targets.some(
      ({ gitLabMergeRequest }) => gitLabMergeRequest,
    )
      ? await this.gitlabInstance().catch(() => null)
      : null;
    const candidates = targets.flatMap((target) => {
      const request = linkedRequest(target, instance);
      return request ? [{ target, request }] : [];
    });
    const active = await activeRequests(
      candidates.map(({ request }) => request.requestKey),
    );
    const output = [];
    for (let index = 0; index < candidates.length; index += 4) {
      output.push(
        ...(await Promise.all(
          candidates
            .slice(index, index + 4)
            .map(async ({ target, request }) => ({
              ...request,
              worktreeId: target.id,
              repositoryName: target.codebase.repository.name,
              agentName: target.codebase.agent.name,
              branch: target.branch!,
              folder: target.folder,
              ...(active.has(request.requestKey)
                ? blocked(ACTIVE_REQUEST)
                : request.provider === "GITLAB" && !instance
                  ? blocked("GitLab is not configured.")
                  : await this.options(target, request).catch((error) =>
                      blocked(message(error)),
                    )),
            })),
        )),
      );
    }
    return output;
  }

  async batch(id: string) {
    const row = await (
      await getPrismaClient()
    ).worktreeMergeBatch.findUnique({ where: { id }, include: batchInclude });
    return row ? batchView(row) : null;
  }

  async batches(scope: Scope) {
    const prisma = await getPrismaClient();
    const where = {
      appId: scope.appId ?? null,
      agentId: scope.agentId ?? null,
    };
    const [active, recent] = await Promise.all([
      prisma.worktreeMergeBatch.findMany({
        where: { ...where, status: "ACTIVE" },
        include: batchInclude,
        orderBy: { createdAt: "desc" },
      }),
      prisma.worktreeMergeBatch.findMany({
        where: { ...where, status: "COMPLETED" },
        include: batchInclude,
        orderBy: { createdAt: "desc" },
        take: 1,
      }),
    ]);
    return [...active, ...recent].map(batchView);
  }

  async start(input: StartWorktreeMergeBatchInput) {
    const requestId = input.requestId.trim();
    if (!requestId || !input.items.length)
      throw new Error("Select at least one worktree to merge.");
    const appId = input.appId ?? null;
    const agentId = input.agentId ?? null;
    const selections = input.items.map(({ github, gitlab, ...item }) => ({
      ...item,
      settings: normalizedSettings({ ...item, github, gitlab }),
    }));
    const worktreeIds = selections.map(({ worktreeId }) => worktreeId);
    if (
      new Set(worktreeIds).size !== selections.length ||
      new Set(selections.map(({ requestKey }) => requestKey)).size !==
        selections.length
    )
      throw new Error("Select only one worktree per pull or merge request.");
    const digest = fingerprint({ appId, agentId, selections });
    const prisma = await getPrismaClient();
    const existing = async () => {
      const row = await prisma.worktreeMergeBatch.findUnique({
        where: { requestId },
        include: batchInclude,
      });
      if (row && row.fingerprint !== digest)
        throw new Error(
          "This request ID was already used for a different Bulk Merge submission.",
        );
      return row;
    };
    const saved = await existing();
    if (saved) return batchView(saved);
    const targets = await prisma.worktree.findMany({
      where: { ...scopeWhere(input), id: { in: worktreeIds } },
      include: targetInclude,
    });
    const byId = new Map(targets.map((target) => [target.id, target]));
    if (byId.size !== selections.length)
      throw new Error(
        "Some selected worktrees no longer exist or are outside this page's scope.",
      );
    const items = selections.map(({ settings, ...item }, position) => {
      const target = byId.get(item.worktreeId)!;
      const request = linkedRequest(
        target,
        settings.provider === "GITLAB" ? settings.instanceUrl : null,
      );
      const error =
        targetBlocked(target) ??
        (request?.requestKey === item.requestKey
          ? null
          : "The linked pull or merge request changed after review.");
      return {
        id: randomUUID(),
        position,
        worktreeId: target.id,
        codebaseId: target.codebaseId,
        agentId: target.codebase.agentId,
        agentName: target.codebase.agent.name,
        repositoryId: target.codebase.repositoryId,
        repositoryName: target.codebase.repository.name,
        branch: target.branch ?? "",
        folder: target.folder,
        gitDirectory: target.gitDirectory,
        sourceOrigin: target.codebase.repository.canonicalOrigin,
        provider: settings.provider,
        requestKey: item.requestKey,
        requestNumber:
          settings.provider === "GITHUB"
            ? settings.input.number
            : settings.input.iid,
        requestTitle:
          request?.requestKey === item.requestKey ? request.requestTitle : "",
        requestUrl:
          request?.requestKey === item.requestKey ? request.requestUrl : "",
        reviewedHeadSha: item.reviewedHeadSha,
        targetBranch: item.reviewedTargetBranch,
        settingsJson: JSON.stringify(settings),
        status: error ? "SKIPPED" : "PENDING",
        error,
        finishedAt: error ? new Date() : null,
      };
    });
    for (let attempt = 0; ; attempt++) {
      const activeRequestsByKey = await activeRequests(
        items.filter((item) => !item.error).map(({ requestKey }) => requestKey),
      );
      const queued = items.map((item) =>
        item.error
          ? item
          : activeRequestsByKey.has(item.requestKey)
            ? {
                ...item,
                status: "SKIPPED",
                error: ACTIVE_REQUEST,
                finishedAt: new Date(),
              }
            : { ...item, activeRequestKey: item.requestKey },
      );
      const active = queued.some((item) => item.status === "PENDING");
      try {
        const row = await prisma.worktreeMergeBatch.create({
          data: {
            id: randomUUID(),
            requestId,
            fingerprint: digest,
            appId,
            agentId,
            status: active ? "ACTIVE" : "COMPLETED",
            finishedAt: active ? null : new Date(),
            items: { create: queued },
          },
          include: batchInclude,
        });
        this.wake();
        return batchView(row);
      } catch (error) {
        const concurrent = await existing();
        if (concurrent) return batchView(concurrent);
        if (
          attempt >= 2 ||
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "P2002"
        )
          throw error;
      }
    }
  }

  private async updateItem(
    item: WorktreeMergeItem,
    data: Prisma.WorktreeMergeItemUpdateManyMutationInput,
  ) {
    const prisma = await getPrismaClient();
    return prisma.$transaction(async (transaction) => {
      const result = await transaction.worktreeMergeItem.updateMany({
        where: {
          id: item.id,
          status: item.status,
          finishedAt: item.finishedAt,
        },
        data,
      });
      if (result.count)
        await transaction.worktreeMergeBatch.updateMany({
          where: { id: item.batchId, status: "ACTIVE" },
          data: { updatedAt: new Date() },
        });
      return result.count > 0;
    });
  }

  private async finish(
    item: WorktreeMergeItem,
    status: "SKIPPED" | "FAILED" | "ATTENTION_REQUIRED",
    error: string,
  ) {
    await this.updateItem(item, {
      status,
      error,
      finishedAt: new Date(),
      activeRequestKey: null,
    });
  }

  private async followUp(item: WorktreeMergeItem, settings: Settings) {
    return settings.provider === "GITHUB"
      ? this.githubMerges.bulkMergeFollowUp(item.worktreeId, item.id)
      : this.gitlabMerges.bulkMergeFollowUp(
          settings.instanceUrl,
          settings.input.projectId,
          settings.input.iid,
          item.id,
        );
  }

  private async merged(
    item: WorktreeMergeItem,
    settings: Settings,
    postMergeError?: string | null,
  ) {
    const saved = await this.updateItem(item, {
      status: "MERGED",
      error: null,
      postMergeError: postMergeError ?? null,
    });
    if (!saved) return;
    await this.projectFollowUp(
      {
        ...item,
        status: "MERGED",
        error: null,
        postMergeError: postMergeError ?? null,
      },
      settings,
    );
  }

  private async projectFollowUp(item: WorktreeMergeItem, settings: Settings) {
    // A confirmed row can survive a restart with its submission reservation still held.
    await recoverMergeReservations(
      item.sourceOrigin,
      item.branch,
      async (recovery) => {
        if (recovery?.provider !== settings.provider) return false;
        if (settings.provider === "GITLAB")
          return (
            recovery.projectId === settings.input.projectId &&
            recovery.iid === settings.input.iid
          );
        return (
          recovery.owner?.toLowerCase() === settings.input.owner &&
          recovery.name?.toLowerCase() === settings.input.name &&
          recovery.number === settings.input.number
        );
      },
    );
    const followUp = await this.followUp(item, settings);
    if (
      !followUp ||
      followUp.state === "COMPLETED" ||
      followUp.state === "ACTION_REQUIRED" ||
      followUp.state === "CANCELED"
    )
      await this.updateItem(item, {
        postMergeError:
          followUp?.state === "ACTION_REQUIRED"
            ? (followUp.lastError ?? item.postMergeError)
            : item.postMergeError,
        finishedAt: new Date(),
        activeRequestKey: null,
      });
  }

  private async matchesGitLab(
    item: WorktreeMergeItem,
    remote: GitLabMergeRequestView,
  ) {
    if (
      remote.sha !== item.reviewedHeadSha ||
      remote.sourceBranch !== item.branch ||
      remote.targetBranch !== item.targetBranch ||
      !remote.sourceProjectId
    )
      return false;
    const source = await this.gitlab.mergeProject(remote.sourceProjectId);
    return (
      normalizeGitOrigin(source.web_url).canonicalOrigin === item.sourceOrigin
    );
  }

  private async recover(item: WorktreeMergeItem, settings: Settings) {
    let matches = false;
    let state: string | undefined;
    try {
      if (settings.provider === "GITHUB") {
        const { owner, name, number } = settings.input;
        const remote = await this.github.pullRequestAutomationState(
          owner,
          name,
          number,
          true,
        );
        state = remote.state;
        matches =
          remote.headRefOid === item.reviewedHeadSha &&
          remote.headRefName === item.branch &&
          remote.baseRefName === item.targetBranch &&
          `github.com/${remote.headRepositoryNameWithOwner?.toLowerCase() ?? ""}` ===
            item.sourceOrigin;
      } else {
        if ((await this.gitlabInstance()) !== settings.instanceUrl) {
          await this.finish(
            item,
            "ATTENTION_REQUIRED",
            "The configured GitLab instance changed before the merge could be confirmed.",
          );
          return true;
        }
        const remote = await this.gitlab.mergeRequestState(
          settings.input.projectId,
          settings.input.iid,
        );
        state = remote.state;
        matches =
          state === "MERGED" && (await this.matchesGitLab(item, remote));
      }
    } catch {
      state = undefined;
      // Confirm from the provider until the observation window expires.
    }
    if (state === "MERGED" && matches) {
      await this.merged(item, settings);
      return true;
    }
    if (
      (state && state !== "OPEN" && state !== "OPENED") ||
      Date.now() - (item.startedAt?.getTime() ?? 0) >= MERGE_CONFIRMATION_MS
    ) {
      await this.finish(
        item,
        "ATTENTION_REQUIRED",
        "The reviewed merge could not be confirmed. Check the request at its provider before retrying.",
      );
      return true;
    }
    return false;
  }

  private async dispatch(
    batch: Batch,
    item: WorktreeMergeItem,
    settings: Settings,
  ): Promise<boolean> {
    const prisma = await getPrismaClient();
    // Two submissions can be accepted simultaneously before either sees the
    // other. Only the earlier one may dispatch or have an uncertain outcome.
    const earlier = await prisma.worktreeMergeItem.findFirst({
      where: {
        requestKey: item.requestKey,
        batch: {
          OR: [
            { createdAt: { lt: batch.createdAt } },
            { createdAt: batch.createdAt, id: { lt: batch.id } },
          ],
        },
        OR: [
          { status: { in: ["PENDING", "SUBMITTING"] }, finishedAt: null },
          {
            status: "ATTENTION_REQUIRED",
            finishedAt: { gte: batch.createdAt },
          },
        ],
      },
      select: { id: true },
    });
    if (earlier) {
      await this.finish(item, "SKIPPED", ACTIVE_REQUEST);
      return true;
    }
    const target = await prisma.worktree.findFirst({
      where: { ...scopeWhere(batch), id: item.worktreeId },
      include: targetInclude,
    });
    const instance =
      settings.provider === "GITLAB"
        ? await this.gitlabInstance().catch(() => null)
        : null;
    const request = target ? linkedRequest(target, instance) : null;
    if (
      !target ||
      target.codebaseId !== item.codebaseId ||
      target.codebase.agentId !== item.agentId ||
      target.codebase.repositoryId !== item.repositoryId ||
      target.codebase.repository.canonicalOrigin !== item.sourceOrigin ||
      target.branch !== item.branch ||
      target.folder !== item.folder ||
      target.gitDirectory !== item.gitDirectory ||
      request?.requestKey !== item.requestKey
    ) {
      await this.finish(
        item,
        "SKIPPED",
        "The worktree or linked request changed after review.",
      );
      return true;
    }
    let options: Options;
    try {
      options = await this.options(target, request);
    } catch (error) {
      await this.finish(item, "FAILED", message(error));
      return true;
    }
    const error =
      options.blockedReason ??
      (options.reviewedHeadSha === item.reviewedHeadSha &&
      options.reviewedTargetBranch === item.targetBranch
        ? null
        : "The source commit or target branch changed after review.");
    if (error) {
      await this.finish(item, "SKIPPED", error);
      return true;
    }
    const startedAt = new Date();
    if (!(await this.updateItem(item, { status: "SUBMITTING", startedAt })))
      return false;
    const submitting = { ...item, status: "SUBMITTING", startedAt };
    const review: BulkMergeReview = {
      itemId: item.id,
      headSha: item.reviewedHeadSha,
      sourceBranch: item.branch,
      sourceOrigin: item.sourceOrigin,
      targetBranch: item.targetBranch,
      ...(settings.provider === "GITLAB"
        ? { instanceUrl: settings.instanceUrl }
        : {}),
    };
    let merged = false;
    let postMergeError: string | null | undefined;
    try {
      if (settings.provider === "GITHUB") {
        const result = await this.githubMerges.mergePullRequest(
          settings.input,
          "WORKTREE_AUTOMATION",
          review,
        );
        merged = result.state === "MERGED";
        postMergeError = result.postMergeError;
      } else {
        const result = await this.gitlabMerges.submit(settings.input, review);
        merged =
          result.mergeRequest.state === "MERGED" &&
          (await this.matchesGitLab(item, result.mergeRequest).catch(
            () => false,
          ));
        postMergeError = result.postMergeError;
      }
    } catch (error) {
      if (isUnknownMergeOutcome(error))
        return this.recover(submitting, settings);
      await this.finish(
        submitting,
        error instanceof MergeSyncNotSubmittedError ? "SKIPPED" : "FAILED",
        message(error),
      );
      return true;
    }
    if (!merged) return this.recover(submitting, settings);
    await this.merged(submitting, settings, postMergeError);
    return true;
  }

  async reconcile() {
    if (this.running) return;
    this.running = true;
    let active = false;
    try {
      const run = async () => {
        const prisma = await getPrismaClient();
        const batches = await prisma.worktreeMergeBatch.findMany({
          where: { status: "ACTIVE" },
          include: batchInclude,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        active = batches.length > 0;
        for (const batch of batches) {
          for (const item of batch.items) {
            if (item.finishedAt) continue;
            const settings = JSON.parse(item.settingsJson) as Settings;
            if (item.status === "MERGED") {
              await this.projectFollowUp(item, settings);
              continue;
            }
            if (item.status === "SUBMITTING") {
              if (!(await this.recover(item, settings))) break;
            } else if (!(await this.dispatch(batch, item, settings))) break;
          }
          await prisma.worktreeMergeBatch.updateMany({
            where: {
              id: batch.id,
              status: "ACTIVE",
              items: { none: { finishedAt: null } },
            },
            data: { status: "COMPLETED", finishedAt: new Date() },
          });
        }
      };
      if (this.polling) await this.polling.run(POLLING_ID, run);
      else await run();
    } catch (error) {
      if (!this.polling)
        console.error("Bulk Merge reconciliation failed", error);
    } finally {
      this.running = false;
      if (this.started) {
        const delay = this.rerun ? 0 : active ? POLL_MS : IDLE_POLL_MS;
        this.rerun = false;
        this.timer = setTimeout(() => void this.reconcile(), delay);
        this.timer.unref();
        this.polling?.schedule(POLLING_ID, new Date(Date.now() + delay));
      }
    }
  }
}
