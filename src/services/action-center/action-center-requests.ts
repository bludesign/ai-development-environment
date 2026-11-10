import "server-only";

import { createHash } from "node:crypto";
import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  ACTION_CENTER_CHANGED_TOPIC,
  INTEGRATION_CONFIGURATION_CHANGED_TOPIC,
  GITHUB_PIPELINE_STATUS_CHANGED_TOPIC,
  GITHUB_REQUEST_CHANGED_TOPIC,
} from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { GitHubPipelineStatusChangeView } from "@/services/github/types";
import type { GitLabService } from "@/services/gitlab";
import { GITLAB_PIPELINE_STATUS_CHANGED_TOPIC } from "@/services/gitlab/gitlab.service";
import { gitLabMergeBlocker } from "@/services/gitlab/gitlab-merge.service";
import { mapIntegrationRequests } from "@/services/integration-request";
import type { PollingService } from "@/services/polling";
import type { NotificationsService } from "@/services/notifications";

import { FAILED_REQUEST_PIPELINE_STATUSES } from "./request-pipeline-status";

export type ActionCenterRequestView = {
  behindCount?: number | null;
  needsRebase?: boolean;
  provider: "GITHUB" | "GITLAB";
  repositoryId: string;
  repositoryName: string;
  number: number;
  branch: string;
  headSha: string;
  url: string;
  draft: boolean;
  pipelineStatus: string;
  pipelineUrl: string | null;
  approvalStatus: string;
  isMine: boolean;
  requiresMyApproval: boolean;
  canMerge: boolean;
  mergeBlockedReason: string | null;
};

/** Keep a green action conservative when provider summaries disagree. */
export function actionCenterMergeReady(
  canMerge: boolean,
  pipeline: string,
  approval: string,
  draft = false,
): boolean {
  return (
    canMerge &&
    !draft &&
    ["SUCCESS", "NONE", "SKIPPED", "NEUTRAL"].includes(
      pipeline.toUpperCase(),
    ) &&
    ["APPROVED", "NONE", "NOT_REQUIRED"].includes(approval.toUpperCase())
  );
}

function requestReason(request: ActionCenterRequestView) {
  if (
    FAILED_REQUEST_PIPELINE_STATUSES.includes(
      request.pipelineStatus.toUpperCase(),
    )
  )
    return "FAILED";
  // A requested reviewer can coexist with optional repository approval.
  if (
    request.canMerge &&
    ["NONE", "NOT_REQUIRED"].includes(request.approvalStatus.toUpperCase())
  )
    return "READY_TO_MERGE";
  if (request.requiresMyApproval) return "REVIEW_REQUIRED";
  return request.canMerge ? "READY_TO_MERGE" : "ACTIVE";
}

type Candidate = {
  approvalRevision?: number;
  lastKnownApprovalStatus?: string;
  providerCanMerge?: boolean;
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  worktreeId: string | null;
  request: ActionCenterRequestView;
};
type RequestProvider = "GITHUB" | "GITLAB";
type GitHubRequestChange = {
  repositoryName: string;
  number: number | null;
  action: string | null;
  event: string;
  updatedAt: string | null;
};

export const ACTION_CENTER_DEFAULTS = {
  hideUnapprovedRequestsInSidebar: true,
  hideRunningPipelineRequestsInSidebar: true,
  maximumRequestAgeDays: 30,
  showMyRequestsInSidebar: true,
  showReviewRequestsInSidebar: true,
  confirmClearAllNotifications: true,
  showIntegrationCountsInSidebar: true,
  showWorktreeCountsInSidebar: true,
};

export function actionCenterRequestCutoff(maximumRequestAgeDays: number) {
  return maximumRequestAgeDays
    ? new Date(Date.now() - maximumRequestAgeDays * 86_400_000)
    : null;
}

export async function actionCenterSettings() {
  const prisma = await getPrismaClient();
  return (
    (await prisma.actionCenterSettings.findUnique({
      where: { id: "default" },
    })) ?? ACTION_CENTER_DEFAULTS
  );
}

/** A local projection keeps provider I/O out of the paginated Action Center read. */
export class ActionCenterRequests {
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warnings: string[] = [];
  private readonly requested = new Set<RequestProvider>();
  private scheduledProviders: RequestProvider[] | null = null;
  private started = false;
  private readonly accountKeys = new Map<RequestProvider, string | null>();
  private readonly closedGitHubRequests = new Map<string, number>();
  private readonly reviewChanges = new Map<string, GitHubRequestChange>();
  private reviewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly accountGenerations: Record<RequestProvider, number> = {
    GITHUB: 0,
    GITLAB: 0,
  };

  constructor(
    private readonly github: GitHubService,
    private readonly gitlab: GitLabService,
    private readonly polling: PollingService,
    private readonly notifications?: NotificationsService,
  ) {}

  getWarnings() {
    return this.warnings;
  }

  /** Undefined until this account's request projection has been reconciled. */
  currentAccountKey(provider: RequestProvider): string | null | undefined {
    return this.accountKeys.get(provider);
  }

  invalidateAccount(provider: RequestProvider): void {
    if (provider === "GITHUB") this.closedGitHubRequests.clear();
    ++this.accountGenerations[provider];
    this.accountKeys.delete(provider);
    if (this.started) {
      if (this.running) this.requested.add(provider);
      else this.schedule(250, [provider]);
    }
  }

  start() {
    this.started = true;
    this.polling.register({
      id: "server:action-center-requests",
      kind: "ACTION_CENTER_REQUESTS",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: 60,
      details: {},
    });
    for (const topic of [
      INTEGRATION_CONFIGURATION_CHANGED_TOPIC,
      GITHUB_PIPELINE_STATUS_CHANGED_TOPIC,
      GITLAB_PIPELINE_STATUS_CHANGED_TOPIC,
    ]) {
      const changes = agentEventBus.iterate(topic);
      void (async () => {
        for await (const change of changes) {
          if (topic === GITHUB_PIPELINE_STATUS_CHANGED_TOPIC) {
            void this.applyGitHubPipeline(change).catch(() => undefined);
            continue;
          }
          if (topic === INTEGRATION_CONFIGURATION_CHANGED_TOPIC) {
            const provider = (
              change as { integrationConfigurationChanged?: string }
            ).integrationConfigurationChanged?.toUpperCase();
            for (const candidate of ["GITHUB", "GITLAB"] as const) {
              if (!provider || provider === "ALL" || provider === candidate)
                // Provider mutations also emit this event. Fence in-flight reads;
                // the sidebar invalidates the key when connection settings change.
                ++this.accountGenerations[candidate];
            }
          }
          // Snapshot observations themselves can emit pipeline updates; polling
          // already includes those observations, so do not recurse into a scan.
          const provider =
            topic === GITLAB_PIPELINE_STATUS_CHANGED_TOPIC
              ? "GITLAB"
              : (
                  change as { integrationConfigurationChanged?: string }
                ).integrationConfigurationChanged?.toUpperCase();
          const providers: RequestProvider[] =
            provider === "GITHUB" || provider === "GITLAB"
              ? [provider]
              : ["GITHUB", "GITLAB"];
          if (!this.running) this.schedule(250, providers);
          else if (topic === INTEGRATION_CONFIGURATION_CHANGED_TOPIC)
            for (const candidate of providers) this.requested.add(candidate);
        }
      })();
    }
    const requests = agentEventBus.iterate<GitHubRequestChange>(
      GITHUB_REQUEST_CHANGED_TOPIC,
    );
    void (async () => {
      for await (const event of requests) {
        if (event.event === "pull_request_review") {
          this.reviewChanges.set(
            `${event.repositoryName.toLowerCase()}:${event.number}`,
            event,
          );
          if (this.reviewTimer) clearTimeout(this.reviewTimer);
          this.reviewTimer = setTimeout(() => {
            this.reviewTimer = null;
            const changes = [...this.reviewChanges.values()];
            this.reviewChanges.clear();
            void (async () => {
              for (const change of changes)
                await this.applyGitHubRequest(change);
            })().catch(() => undefined);
          }, 250);
          this.reviewTimer.unref?.();
          continue;
        }
        await this.applyGitHubRequest(event).catch(() => undefined);
      }
    })();
    this.schedule(0);
  }

  private schedule(
    delay: number,
    providers: RequestProvider[] = ["GITHUB", "GITLAB"],
  ) {
    if (delay < 1_000 && this.scheduledProviders)
      providers = [...new Set([...providers, ...this.scheduledProviders])];
    this.scheduledProviders = delay < 1_000 ? providers : null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledProviders = null;
      void this.refresh(providers)
        .catch(() => undefined)
        .finally(() => {
          if (!this.timer) this.schedule(60_000);
        });
    }, delay);
    this.timer.unref?.();
    this.polling.schedule(
      "server:action-center-requests",
      new Date(Date.now() + delay),
    );
  }

  refresh(
    providers: RequestProvider[] = ["GITHUB", "GITLAB"],
    force = false,
  ): Promise<boolean> {
    if (this.running) {
      if (force) return this.running.then(() => this.refresh(providers, true));
      for (const provider of providers) this.requested.add(provider);
      return this.running;
    }
    this.running = this.polling
      .run("server:action-center-requests", () => this.scan(providers, force))
      .finally(() => {
        this.running = null;
        if (this.requested.size) {
          const pending = [...this.requested];
          this.requested.clear();
          this.schedule(250, pending);
        }
      });
    return this.running;
  }

  private async applyGitHubPipeline(event: unknown): Promise<void> {
    const change = (
      event as { githubPipelineStatusChanged?: GitHubPipelineStatusChangeView }
    ).githubPipelineStatusChanged;
    const accountKey = this.accountKeys.get("GITHUB");
    if (!change || !accountKey) return;
    const prisma = await getPrismaClient();
    const rows = await prisma.actionCenterRequest.findMany({
      where: { provider: "GITHUB", accountKey },
    });
    for (const row of rows) {
      const candidate = JSON.parse(row.payloadJson) as Candidate;
      const request = candidate.request;
      if (
        request.repositoryId !== change.snapshot.repositoryGithubId ||
        request.headSha !== change.snapshot.headSha
      )
        continue;
      request.pipelineStatus = change.snapshot.pipelineStatus;
      request.pipelineUrl =
        change.snapshot.pipelines[0]?.url ?? request.pipelineUrl;
      candidate.providerCanMerge ??= request.canMerge;
      request.canMerge = actionCenterMergeReady(
        candidate.providerCanMerge,
        request.pipelineStatus,
        request.approvalStatus,
        request.draft,
      );
      await prisma.actionCenterRequest.updateMany({
        where: { id: row.id, accountKey, payloadJson: row.payloadJson },
        data: {
          payloadJson: JSON.stringify(candidate),
          reason: requestReason(request),
        },
      });
    }
    agentEventBus.publish(ACTION_CENTER_CHANGED_TOPIC, {
      actionCenterChanged: true,
    });
  }

  private async applyGitHubRequest(event: GitHubRequestChange): Promise<void> {
    ++this.accountGenerations.GITHUB;
    const accountKey = this.accountKeys.get("GITHUB");
    const prisma = await getPrismaClient();
    const key = `${event.repositoryName.toLowerCase()}:${event.number}`;
    if (event.action === "closed" && event.number) {
      this.closedGitHubRequests.set(
        key,
        Math.max(
          this.closedGitHubRequests.get(key) ?? 0,
          event.updatedAt ? Date.parse(event.updatedAt) : Date.now(),
        ),
      );
      if (this.closedGitHubRequests.size > 1000)
        this.closedGitHubRequests.delete(
          this.closedGitHubRequests.keys().next().value!,
        );
      if (accountKey) {
        const rows = await prisma.actionCenterRequest.findMany({
          where: { provider: "GITHUB", accountKey },
        });
        for (const row of rows) {
          const { request } = JSON.parse(row.payloadJson) as Candidate;
          if (
            request.repositoryName.toLowerCase() ===
              event.repositoryName.toLowerCase() &&
            request.number === event.number &&
            (!event.updatedAt || row.updatedAt <= new Date(event.updatedAt))
          )
            await prisma.actionCenterRequest.deleteMany({
              where: { id: row.id, accountKey, updatedAt: row.updatedAt },
            });
        }
      }
      agentEventBus.publish(ACTION_CENTER_CHANGED_TOPIC, {
        actionCenterChanged: true,
      });
      return;
    }
    if (event.action === "reopened") {
      const closedAt = this.closedGitHubRequests.get(key);
      if (closedAt && event.updatedAt && Date.parse(event.updatedAt) < closedAt)
        return;
      this.closedGitHubRequests.delete(key);
    }
    // Review state can be refreshed for known requests without account-wide discovery.
    if (accountKey && event.event === "pull_request_review" && event.number) {
      const generation = this.accountGenerations.GITHUB;
      const rows = (
        await prisma.actionCenterRequest.findMany({
          where: { provider: "GITHUB", accountKey },
        })
      ).filter((row) => {
        const { request } = JSON.parse(row.payloadJson) as Candidate;
        return (
          request.repositoryName.toLowerCase() ===
            event.repositoryName.toLowerCase() &&
          request.number === event.number
        );
      });
      if (rows.length) {
        const candidates = rows.map(
          (row) => JSON.parse(row.payloadJson) as Candidate,
        );
        const states = await this.github.actionCenterRequestStates(
          candidates.map((candidate) => ({
            id: candidate.id,
            headRefOid: candidate.request.headSha,
          })),
          accountKey,
          true,
        );
        if (generation !== this.accountGenerations.GITHUB) return;
        for (const candidate of candidates) {
          const state = states.get(candidate.id)!;
          await this.persistCandidate(
            "GITHUB",
            accountKey,
            candidate,
            () => generation === this.accountGenerations.GITHUB,
            (current) => {
              if (current.request.headSha !== candidate.request.headSha)
                return null;
              const request = current.request;
              const approvalStatus =
                state.approvalStatus ?? request.approvalStatus;
              return {
                ...current,
                providerCanMerge: state.canMerge,
                request: {
                  ...request,
                  approvalStatus,
                  behindCount: state.behindCount ?? null,
                  needsRebase: state.needsRebase ?? false,
                  requiresMyApproval:
                    state.viewerReviewState === "DISMISSED" ||
                    (request.requiresMyApproval && !state.viewerHasApproved),
                  canMerge: actionCenterMergeReady(
                    state.canMerge,
                    request.pipelineStatus,
                    approvalStatus,
                    request.draft,
                  ),
                  mergeBlockedReason: state.mergeBlockedReason,
                },
              };
            },
          );
        }
        agentEventBus.publish(ACTION_CENTER_CHANGED_TOPIC, {
          actionCenterChanged: true,
        });
        return;
      }
    }
    if (this.running) this.requested.add("GITHUB");
    else this.schedule(250, ["GITHUB"]);
  }

  private async reconcile(
    provider: string,
    accountKey: string | null,
    collect: (add: (candidate: Candidate) => void) => Promise<void>,
    valid: () => boolean = () => true,
  ) {
    const prisma = await getPrismaClient();
    // Do not expose a previous account's private requests after a connection changes.
    await prisma.actionCenterRequest.deleteMany({
      where: {
        provider,
        ...(accountKey ? { accountKey: { not: accountKey } } : {}),
      },
    });
    if (!accountKey) return;
    const candidates = new Map<string, Candidate>();
    const add = (candidate: Candidate) => {
      const previous = candidates.get(candidate.id);
      candidate.request.isMine ||= previous?.request.isMine ?? false;
      candidate.request.requiresMyApproval ||=
        previous?.request.requiresMyApproval ?? false;
      candidates.set(candidate.id, candidate);
    };
    let complete = true;
    try {
      await collect(add);
    } catch (error) {
      complete = false;
      this.warnings.push(
        `${provider}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!valid()) return;
    await mapIntegrationRequests([...candidates.values()], (candidate) =>
      this.persistCandidate(provider, accountKey, candidate, valid),
    );
    // A partial scan may update known rows but must never remove unseen requests.
    if (complete) {
      const ids = [...candidates.keys()].map(
        (id) =>
          `${provider}:${createHash("sha256").update(accountKey).digest("hex").slice(0, 16)}:${id}`,
      );
      await prisma.actionCenterRequest.deleteMany({
        where: { provider, accountKey, id: { notIn: ids } },
      });
    }
  }

  private async persistCandidate(
    provider: string,
    accountKey: string,
    candidate: Candidate,
    valid: () => boolean = () => true,
    updateCurrent?: (current: Candidate) => Candidate | null,
  ) {
    const prisma = await getPrismaClient();
    const notification = await prisma.$transaction(async (transaction) => {
      const resourceKind =
        provider === "GITHUB" ? "PULL_REQUEST" : "MERGE_REQUEST";
      const id = `${provider}:${createHash("sha256").update(accountKey).digest("hex").slice(0, 16)}:${candidate.id}`;
      const row = await transaction.actionCenterRequest.findUnique({
        where: { id },
      });
      if (!valid()) return null;
      const previous = row ? (JSON.parse(row.payloadJson) as Candidate) : null;
      if (updateCurrent) {
        // A review lookup can outlive a pipeline observation. Merge its fields
        // into the current row so readiness uses the latest pipeline state.
        const updated = previous ? updateCurrent(previous) : null;
        if (!updated) return null;
        candidate = updated;
      }
      const request = candidate.request;
      const previousApproval =
        previous?.lastKnownApprovalStatus ?? previous?.request.approvalStatus;
      const authoritative = !["UNKNOWN", ""].includes(
        request.approvalStatus.toUpperCase(),
      );
      candidate.lastKnownApprovalStatus = authoritative
        ? request.approvalStatus
        : previousApproval;
      const changed =
        authoritative && previousApproval !== request.approvalStatus;
      candidate.approvalRevision =
        (previous?.approvalRevision ?? 0) + (changed ? 1 : 0);
      const data = {
        provider,
        accountKey,
        resourceKind,
        reason: requestReason(request),
        isMine: request.isMine,
        requiresMyApproval: request.requiresMyApproval,
        payloadJson: JSON.stringify(candidate),
        createdAt: new Date(candidate.createdAt),
        updatedAt: new Date(candidate.updatedAt),
      };
      await transaction.actionCenterRequest.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      });
      if (
        !this.notifications ||
        !previous ||
        request.approvalStatus !== "APPROVED" ||
        ![
          "REVIEW_REQUIRED",
          "CHANGES_REQUESTED",
          "NOT_APPROVED",
          "PENDING",
          "DISMISSED",
        ].includes(previousApproval ?? "")
      )
        return null;
      return this.notifications.recordInTransaction(transaction, {
        typeKey:
          provider === "GITHUB"
            ? "GITHUB_PULL_REQUEST_APPROVED"
            : "GITLAB_MERGE_REQUEST_APPROVED",
        dedupeKey: `${id}:approved:${candidate.approvalRevision}`,
        title: `${provider === "GITHUB" ? "Pull" : "Merge"} request approved`,
        body: `${request.repositoryName} ${provider === "GITHUB" ? "#" : "!"}${request.number}: ${candidate.label}`,
        href:
          provider === "GITHUB"
            ? `/github/pull-requests/${request.repositoryName.split("/").map(encodeURIComponent).join("/")}/${request.number}`
            : `/gitlab/merge-requests/${encodeURIComponent(request.repositoryId)}/${request.number}`,
        resourceKind,
        resourceId: candidate.id,
        worktreeId: candidate.worktreeId,
      });
    });
    this.notifications?.created(notification);
  }

  private async scan(providers: RequestProvider[], force = false) {
    this.warnings = this.warnings.filter(
      (warning) =>
        !providers.some((provider) => warning.startsWith(`${provider}:`)),
    );
    const settings = await actionCenterSettings();
    const cutoff =
      actionCenterRequestCutoff(
        settings.maximumRequestAgeDays,
      )?.toISOString() ?? null;
    const outcomes = await Promise.allSettled([
      (async () => {
        if (!providers.includes("GITHUB")) return;
        const generation = this.accountGenerations.GITHUB;
        const login = await this.github.actionCenterIdentity();
        if (generation !== this.accountGenerations.GITHUB) return;
        if (this.accountKeys.get("GITHUB") !== login)
          this.accountKeys.delete("GITHUB");
        await this.reconcile(
          "GITHUB",
          login,
          async (add) => {
            const remoteCutoff = cutoff ? new Date(cutoff) : null;
            remoteCutoff?.setUTCHours(0, 0, 0, 0);
            const discovered = new Map<
              string,
              {
                pr: Awaited<
                  ReturnType<GitHubService["pullRequests"]>
                >["items"][number];
                scopes: Set<string>;
              }
            >();
            let discoveryError: unknown;
            try {
              for (const scope of [
                "MINE",
                "REVIEW_REQUESTED",
                "REVIEWED",
              ] as const) {
                let after: string | null = null;
                do {
                  const page = await this.github.pullRequests(
                    scope === "REVIEWED" ? "REVIEW_REQUESTED" : scope,
                    null,
                    {
                      first: 25,
                      after,
                      state: "OPEN",
                      includePipelineJobs: false,
                      createdAfter: remoteCutoff?.toISOString() ?? null,
                      reviewedByViewer: scope === "REVIEWED",
                      requestSource: "ACTION_CENTER_REQUESTS",
                      force,
                    },
                  );
                  for (const pr of page.items) {
                    if (
                      pr.state !== "OPEN" ||
                      (cutoff && Date.parse(pr.createdAt) < Date.parse(cutoff))
                    )
                      continue;
                    const closedAt = this.closedGitHubRequests.get(
                      `${pr.repositoryNameWithOwner.toLowerCase()}:${pr.number}`,
                    );
                    if (
                      closedAt &&
                      Date.parse(pr.updatedAt ?? pr.createdAt) <= closedAt
                    )
                      continue;
                    const previous = discovered.get(pr.id);
                    if (previous) {
                      previous.scopes.add(scope);
                      if (
                        Date.parse(pr.updatedAt ?? pr.createdAt) >
                        Date.parse(
                          previous.pr.updatedAt ?? previous.pr.createdAt,
                        )
                      )
                        previous.pr = pr;
                    } else
                      discovered.set(pr.id, { pr, scopes: new Set([scope]) });
                  }
                  if (page.truncated)
                    throw new Error(
                      "GitHub search limit reached; request discovery is incomplete.",
                    );
                  after = page.hasNextPage ? page.endCursor : null;
                } while (after);
              }
            } catch (error) {
              discoveryError = error;
            }
            // Enrich once per unique request, even when discovery is partial.
            const states = await this.github.actionCenterRequestStates(
              [...discovered.values()].map(({ pr }) => pr),
              login!,
              force,
            );
            for (const { pr, scopes } of discovered.values()) {
              const state = states.get(pr.id)!;
              const request: ActionCenterRequestView = {
                provider: "GITHUB",
                repositoryId: pr.repositoryGithubId,
                repositoryName: pr.repositoryNameWithOwner,
                number: pr.number,
                branch: pr.headRefName,
                headSha: pr.headRefOid,
                url: pr.url,
                draft: pr.isDraft,
                pipelineStatus: pr.pipelineStatus,
                pipelineUrl: pr.pipelines[0]?.url ?? null,
                approvalStatus: state.approvalStatus ?? pr.reviewDecision,
                behindCount: state.behindCount ?? null,
                needsRebase: state.needsRebase ?? false,
                isMine: scopes.has("MINE"),
                requiresMyApproval:
                  (scopes.has("REVIEW_REQUESTED") &&
                    !state.viewerHasApproved) ||
                  (scopes.has("REVIEWED") &&
                    state.viewerReviewState === "DISMISSED"),
                canMerge: actionCenterMergeReady(
                  state.canMerge,
                  pr.pipelineStatus,
                  state.approvalStatus ?? pr.reviewDecision,
                  pr.isDraft,
                ),
                mergeBlockedReason: state.mergeBlockedReason,
              };
              add({
                id: pr.id,
                label: pr.title,
                createdAt: pr.createdAt,
                updatedAt: pr.updatedAt ?? pr.createdAt,
                worktreeId: pr.worktreeId,
                providerCanMerge: state.canMerge,
                request,
              });
            }
            if (discoveryError) throw discoveryError;
          },
          () => generation === this.accountGenerations.GITHUB,
        );
        if (generation === this.accountGenerations.GITHUB)
          this.accountKeys.set("GITHUB", login);
      })(),
      (async () => {
        if (!providers.includes("GITLAB")) return;
        const generation = this.accountGenerations.GITLAB;
        const config = await this.gitlab.getSettings();
        if (generation !== this.accountGenerations.GITLAB) return;
        const account =
          config.configured && config.viewer
            ? `${config.baseUrl}:${config.viewer.id}`
            : null;
        if (this.accountKeys.get("GITLAB") !== account)
          this.accountKeys.delete("GITLAB");
        await this.reconcile(
          "GITLAB",
          account,
          async (add) => {
            for (const scope of ["MINE", "REVIEW_REQUESTED"] as const) {
              let pageNumber: number | null = 1;
              do {
                const page = await this.gitlab.mergeRequests({
                  scope,
                  state: "OPENED",
                  page: pageNumber,
                  perPage: 25,
                  createdAfter: cutoff,
                  force,
                  projectScope: "ALL",
                });
                await mapIntegrationRequests(page.items, async (mr) => {
                  if (
                    mr.state !== "OPENED" ||
                    (cutoff && mr.createdAt < cutoff)
                  )
                    return;
                  const [state, approved] = await Promise.all([
                    this.gitlab.mergeReadiness(mr.projectId, mr.iid, force),
                    this.gitlab.actionCenterApproval(
                      mr.projectId,
                      mr.iid,
                      config.viewer!.id,
                      force,
                    ),
                  ]);
                  const blockedReason = gitLabMergeBlocker(
                    state.mr,
                    state.canMerge,
                  );
                  const sameHead = state.mr.sha === mr.sha;
                  const headPipeline = sameHead
                    ? (state.mr.headPipeline ?? mr.headPipeline)
                    : mr.headPipeline;
                  const approvalStatus =
                    sameHead && state.mr.detailedMergeStatus === "not_approved"
                      ? "REVIEW_REQUIRED"
                      : sameHead &&
                          state.mr.detailedMergeStatus === "requested_changes"
                        ? "CHANGES_REQUESTED"
                        : (mr.approvalState ?? "UNKNOWN");
                  const request: ActionCenterRequestView = {
                    provider: "GITLAB",
                    repositoryId: mr.projectId,
                    repositoryName: mr.projectPath ?? mr.projectId,
                    number: mr.iid,
                    branch: mr.sourceBranch,
                    headSha: mr.sha,
                    url: mr.webUrl,
                    draft: mr.draft,
                    pipelineStatus: headPipeline?.status ?? "NONE",
                    pipelineUrl: headPipeline?.webUrl ?? null,
                    approvalStatus,
                    behindCount: state.mr.behindCount ?? null,
                    needsRebase: state.mr.detailedMergeStatus === "need_rebase",
                    isMine: scope === "MINE",
                    requiresMyApproval:
                      scope === "REVIEW_REQUESTED" && !approved,
                    canMerge: actionCenterMergeReady(
                      blockedReason === null && sameHead,
                      headPipeline?.status ?? "NONE",
                      approvalStatus,
                      mr.draft,
                    ),
                    mergeBlockedReason: blockedReason,
                  };
                  add({
                    id: `${mr.projectId}:${mr.iid}`,
                    label: mr.title,
                    createdAt: mr.createdAt,
                    updatedAt: mr.updatedAt,
                    worktreeId: mr.worktreeId ?? null,
                    request,
                  });
                });
                pageNumber = page.nextPage;
              } while (pageNumber);
            }
          },
          () => generation === this.accountGenerations.GITLAB,
        );
        if (generation === this.accountGenerations.GITLAB)
          this.accountKeys.set("GITLAB", account);
      })(),
    ]);
    for (const [index, result] of outcomes.entries())
      if (result.status === "rejected")
        this.warnings.push(
          `${index === 0 ? "GITHUB" : "GITLAB"}: ${String(result.reason)}`,
        );
    agentEventBus.publish(ACTION_CENTER_CHANGED_TOPIC, {
      actionCenterChanged: true,
    });
    return true;
  }
}
