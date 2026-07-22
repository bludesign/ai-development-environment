import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import { CREDENTIALS, type CredentialService } from "@/services/credentials";
import type {
  NotificationRecord,
  NotificationsService,
} from "@/services/notifications";
import type { PollingService } from "@/services/polling";

const OPERATION_ID = "server:github-actions-notifications";
const DEFAULT_INTERVAL_SECONDS = 60;
const GITHUB_RUNS_PAGE_SIZE = 100;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
]);

type RepositoryTarget = {
  id: string;
  name: string;
  owner: string;
  repository: string;
};

type WorkflowRun = {
  id: string;
  workflowId: string;
  runAttempt: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
  url: string;
  updatedAt: Date;
};

type WebhookResult = {
  outcome: "DUPLICATE" | "IGNORED" | "PROCESSED";
  notificationCreated: boolean;
};

function secureEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function notificationType(conclusion: string | null) {
  if (conclusion === "success") return "GITHUB_ACTIONS_SUCCEEDED" as const;
  if (conclusion && FAILURE_CONCLUSIONS.has(conclusion)) {
    return "GITHUB_ACTIONS_FAILED" as const;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export class GitHubActionsNotificationsService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;

  constructor(
    private readonly credentials: CredentialService,
    private readonly notifications: NotificationsService,
    private readonly polling: PollingService,
    startPolling = true,
  ) {
    this.polling.register({
      id: OPERATION_ID,
      kind: "GITHUB_ACTIONS_NOTIFICATIONS",
      runtime: "SERVER",
      enabled: false,
      cadenceSeconds: DEFAULT_INTERVAL_SECONDS,
      details: { mode: "DISABLED" },
    });
    if (startPolling) queueMicrotask(() => void this.tick());
  }

  private schedule(seconds: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(30, seconds) * 1_000;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
    this.polling.schedule(OPERATION_ID, new Date(Date.now() + delay));
  }

  configurationChanged(): void {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    queueMicrotask(() => void this.tick());
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
    try {
      const prisma = await getPrismaClient();
      const [settings, app, tokenConfigured, webhookSecretConfigured] =
        await Promise.all([
          prisma.gitHubSettings.upsert({
            where: { id: "default" },
            create: { id: "default" },
            update: {},
          }),
          prisma.gitHubAppSettings.findUnique({ where: { id: "default" } }),
          this.credentials.isConfigured(CREDENTIALS.githubPersonalAccessToken),
          this.credentials.isConfigured(CREDENTIALS.githubAppWebhookSecret),
        ]);
      intervalSeconds = settings.actionsNotificationPollIntervalSeconds;
      const webhookConfigured = Boolean(
        app?.webhookUrl && app.webhookConfiguredAt && webhookSecretConfigured,
      );
      if (webhookConfigured) {
        this.polling.configure(OPERATION_ID, {
          enabled: false,
          cadenceSeconds: intervalSeconds,
          details: { mode: "WEBHOOK" },
        });
        return;
      }
      if (!tokenConfigured) {
        this.polling.configure(OPERATION_ID, {
          enabled: false,
          cadenceSeconds: intervalSeconds,
          details: { mode: "DISABLED", reason: "GITHUB_TOKEN_REQUIRED" },
        });
        return;
      }
      this.polling.configure(OPERATION_ID, {
        enabled: true,
        cadenceSeconds: intervalSeconds,
        details: { mode: "POLLING" },
      });
      await this.polling.run(
        OPERATION_ID,
        () => this.pollRepositories(),
        (result) => result,
      );
    } catch {
      // The polling coordinator retains the error for the dashboard.
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        queueMicrotask(() => void this.tick());
      } else {
        this.schedule(intervalSeconds);
      }
    }
  }

  private async repositories(): Promise<RepositoryTarget[]> {
    const repositories = await (
      await getPrismaClient()
    ).codebaseRepository.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, canonicalOrigin: true },
    });
    return repositories.flatMap((repository) => {
      const match = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(
        repository.canonicalOrigin.trim(),
      );
      if (!match?.[1] || !match[2]) return [];
      return [
        {
          id: repository.id,
          name: repository.name,
          owner: match[1],
          repository: match[2],
        },
      ];
    });
  }

  private async fetchRuns(
    target: RepositoryTarget,
    token: string,
    updatedAfter: Date | null,
  ): Promise<WorkflowRun[]> {
    const runs: WorkflowRun[] = [];
    for (let page = 1; ; page += 1) {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/actions/runs?per_page=${GITHUB_RUNS_PAGE_SIZE}&page=${page}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "ai-development-environment",
            "x-github-api-version": "2022-11-28",
          },
          cache: "no-store",
        },
      );
      const body = (await response.json().catch(() => null)) as {
        workflow_runs?: Array<Record<string, unknown>>;
        message?: string;
      } | null;
      if (!response.ok || !Array.isArray(body?.workflow_runs)) {
        throw new Error(
          body?.message ||
            `GitHub returned HTTP ${response.status} while polling ${target.owner}/${target.repository}`,
        );
      }
      const pageRuns = body.workflow_runs.flatMap((run) => {
        const id = positiveInteger(run.id);
        const workflowId = positiveInteger(run.workflow_id);
        const updatedAtValue = text(run.updated_at);
        const updatedAt = updatedAtValue ? new Date(updatedAtValue) : null;
        if (
          !id ||
          !workflowId ||
          !updatedAt ||
          !Number.isFinite(updatedAt.getTime())
        ) {
          return [];
        }
        return [
          {
            id: String(id),
            workflowId: String(workflowId),
            runAttempt: positiveInteger(run.run_attempt) ?? 1,
            name: text(run.name) ?? "GitHub Actions",
            displayTitle:
              text(run.display_title) ?? text(run.name) ?? "Workflow run",
            status: text(run.status)?.toLowerCase() ?? "unknown",
            conclusion: text(run.conclusion)?.toLowerCase() ?? null,
            headBranch: text(run.head_branch),
            url: text(run.html_url) ?? "",
            updatedAt,
          },
        ];
      });
      runs.push(...pageRuns);
      if (
        !updatedAfter ||
        body.workflow_runs.length < GITHUB_RUNS_PAGE_SIZE ||
        pageRuns.some((run) => run.updatedAt <= updatedAfter)
      ) {
        return runs;
      }
    }
  }

  private async worktreeContext(
    transaction: Prisma.TransactionClient,
    codebaseRepositoryId: string,
    branch: string | null,
  ): Promise<{ id: string; highlightColor: string | null } | null> {
    if (!branch) return null;
    return transaction.worktree.findFirst({
      where: {
        branch,
        missingAt: null,
        codebase: { repositoryId: codebaseRepositoryId },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, highlightColor: true },
    });
  }

  private async observeRun(
    transaction: Prisma.TransactionClient,
    target: RepositoryTarget,
    run: WorkflowRun,
    source: "POLL" | "WEBHOOK",
    shouldNotifyNewRun: boolean,
  ): Promise<NotificationRecord | null> {
    const now = new Date();
    const typeKey = notificationType(run.conclusion);
    const existing = await transaction.gitHubWorkflowRunObservation.findUnique({
      where: {
        codebaseRepositoryId_workflowRunId_runAttempt: {
          codebaseRepositoryId: target.id,
          workflowRunId: run.id,
          runAttempt: run.runAttempt,
        },
      },
    });
    await transaction.gitHubWorkflowRunObservation.upsert({
      where: {
        codebaseRepositoryId_workflowRunId_runAttempt: {
          codebaseRepositoryId: target.id,
          workflowRunId: run.id,
          runAttempt: run.runAttempt,
        },
      },
      create: {
        id: randomUUID(),
        codebaseRepositoryId: target.id,
        workflowRunId: run.id,
        runAttempt: run.runAttempt,
        workflowId: run.workflowId,
        status: run.status,
        conclusion: run.conclusion,
        githubUpdatedAt: run.updatedAt,
        source,
        lastObservedAt: now,
      },
      update: {
        workflowId: run.workflowId,
        status: run.status,
        conclusion: run.conclusion,
        githubUpdatedAt: run.updatedAt,
        source,
        lastObservedAt: now,
      },
    });
    const isNewTerminalTransition = existing
      ? existing.status !== "completed" ||
        existing.conclusion !== run.conclusion
      : shouldNotifyNewRun;
    if (
      !isNewTerminalTransition ||
      !typeKey ||
      run.status !== "completed" ||
      existing?.notifiedAt
    ) {
      return null;
    }
    const worktree = await this.worktreeContext(
      transaction,
      target.id,
      run.headBranch,
    );
    const params = new URLSearchParams({ repository: target.id });
    if (run.headBranch) params.set("branch", run.headBranch);
    params.set("pipeline", run.workflowId);
    const notification = await this.notifications.recordInTransaction(
      transaction,
      {
        dedupeKey: `github-actions:${target.id}:${run.id}:${run.runAttempt}`,
        typeKey,
        title:
          typeKey === "GITHUB_ACTIONS_SUCCEEDED"
            ? "GitHub Actions succeeded"
            : "GitHub Actions failed",
        body: [target.name, run.name, run.headBranch]
          .filter((value): value is string => Boolean(value))
          .join(" · "),
        href: `/actions?${params.toString()}`,
        resourceKind: "GITHUB_WORKFLOW_RUN",
        resourceId: `${target.id}:${run.id}:${run.runAttempt}`,
        worktreeId: worktree?.id ?? null,
        highlightColor: worktree?.highlightColor ?? null,
      },
    );
    await transaction.gitHubWorkflowRunObservation.update({
      where: {
        codebaseRepositoryId_workflowRunId_runAttempt: {
          codebaseRepositoryId: target.id,
          workflowRunId: run.id,
          runAttempt: run.runAttempt,
        },
      },
      data: { notifiedAt: now },
    });
    return notification;
  }

  private async pollRepository(
    target: RepositoryTarget,
    token: string,
  ): Promise<number> {
    const prisma = await getPrismaClient();
    const startedAt = new Date();
    const state = await prisma.gitHubActionsPollingState.findUnique({
      where: { codebaseRepositoryId: target.id },
    });
    await prisma.gitHubActionsPollingState.upsert({
      where: { codebaseRepositoryId: target.id },
      create: {
        codebaseRepositoryId: target.id,
        initializedAt: startedAt,
        lastPollStartedAt: startedAt,
      },
      update: { lastPollStartedAt: startedAt },
    });
    try {
      const runs = await this.fetchRuns(
        target,
        token,
        state ? (state.lastPollSucceededAt ?? state.initializedAt) : null,
      );
      const notifications: NotificationRecord[] = [];
      await prisma.$transaction(async (transaction) => {
        for (const run of runs) {
          const created = await this.observeRun(
            transaction,
            target,
            run,
            "POLL",
            Boolean(
              state &&
              run.updatedAt >
                (state.lastPollSucceededAt ?? state.initializedAt),
            ),
          );
          if (created) notifications.push(created);
        }
        const completedAt = new Date();
        await transaction.gitHubActionsPollingState.update({
          where: { codebaseRepositoryId: target.id },
          data: {
            lastPollCompletedAt: completedAt,
            lastPollSucceededAt: completedAt,
            lastError: null,
          },
        });
      });
      notifications.forEach((notification) =>
        this.notifications.created(notification),
      );
      return notifications.length;
    } catch (error) {
      await prisma.gitHubActionsPollingState.update({
        where: { codebaseRepositoryId: target.id },
        data: {
          lastPollCompletedAt: new Date(),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private async pollRepositories(): Promise<Record<string, unknown>> {
    const token = await this.credentials.getText(
      CREDENTIALS.githubPersonalAccessToken,
    );
    if (!token) throw new Error("GitHub personal access token is unavailable");
    const repositories = await this.repositories();
    const results = await Promise.allSettled(
      repositories.map((repository) => this.pollRepository(repository, token)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    const notificationsCreated = results.reduce(
      (count, result) =>
        count + (result.status === "fulfilled" ? result.value : 0),
      0,
    );
    await this.prune();
    if (failures.length === repositories.length && repositories.length > 0) {
      throw failures[0]!.reason;
    }
    return {
      mode: "POLLING",
      repositories: repositories.length,
      failures: failures.length,
      notificationsCreated,
    };
  }

  private async prune(): Promise<void> {
    const before = new Date(Date.now() - RETENTION_MS);
    const prisma = await getPrismaClient();
    await Promise.all([
      prisma.gitHubWorkflowRunObservation.deleteMany({
        where: { lastObservedAt: { lt: before } },
      }),
      prisma.gitHubWebhookDelivery.deleteMany({
        where: { receivedAt: { lt: before } },
      }),
    ]);
  }

  async handleWebhook(input: {
    body: Uint8Array;
    signature: string | null;
    event: string | null;
    deliveryId: string | null;
  }): Promise<WebhookResult> {
    const secret = await this.credentials.getText(
      CREDENTIALS.githubAppWebhookSecret,
    );
    if (!secret) throw new Error("GitHub webhook is not configured");
    if (!input.signature?.startsWith("sha256=")) {
      throw new Error("GitHub webhook signature is missing");
    }
    const expected = `sha256=${createHmac("sha256", secret)
      .update(input.body)
      .digest("hex")}`;
    if (!secureEqual(expected, input.signature)) {
      throw new Error("GitHub webhook signature is invalid");
    }
    if (!input.deliveryId?.trim()) {
      throw new Error("GitHub delivery ID is missing");
    }
    const prisma = await getPrismaClient();
    const deliveryId = input.deliveryId.trim();
    try {
      await prisma.gitHubWebhookDelivery.create({
        data: {
          deliveryId,
          event: input.event ?? "unknown",
          outcome: "RECEIVED",
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const retried = await prisma.gitHubWebhookDelivery.updateMany({
          where: {
            deliveryId,
            outcome: { notIn: ["PROCESSED", "IGNORED"] },
          },
          data: {
            event: input.event ?? "unknown",
            action: null,
            repositoryName: null,
            workflowRunId: null,
            outcome: "RECEIVED",
            error: null,
            receivedAt: new Date(),
            processedAt: null,
          },
        });
        if (retried.count === 0) {
          return { outcome: "DUPLICATE", notificationCreated: false };
        }
      } else {
        throw error;
      }
    }
    const finish = async (
      outcome: string,
      error: string | null = null,
    ): Promise<void> => {
      await prisma.gitHubWebhookDelivery.update({
        where: { deliveryId },
        data: { outcome, error, processedAt: new Date() },
      });
    };
    try {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(
          Buffer.from(input.body).toString("utf8"),
        ) as Record<string, unknown>;
      } catch {
        throw new Error("GitHub webhook payload is invalid JSON");
      }
      const action = text(payload.action);
      const repository = payload.repository as
        Record<string, unknown> | undefined;
      const workflow = payload.workflow_run as
        Record<string, unknown> | undefined;
      await prisma.gitHubWebhookDelivery.update({
        where: { deliveryId },
        data: {
          action,
          repositoryName: text(repository?.full_name),
          workflowRunId: positiveInteger(workflow?.id)?.toString() ?? null,
        },
      });
      if (input.event !== "workflow_run" || action !== "completed") {
        await finish("IGNORED");
        return { outcome: "IGNORED", notificationCreated: false };
      }
      const app = await prisma.gitHubAppSettings.findUnique({
        where: { id: "default" },
      });
      const installation = payload.installation as
        Record<string, unknown> | undefined;
      if (
        !app ||
        String(positiveInteger(installation?.id) ?? "") !== app.installationId
      ) {
        await finish("IGNORED", "Installation does not match configured App");
        return { outcome: "IGNORED", notificationCreated: false };
      }
      const fullName = text(repository?.full_name);
      const runId = positiveInteger(workflow?.id);
      const workflowId = positiveInteger(workflow?.workflow_id);
      const updatedAtText = text(workflow?.updated_at);
      if (!fullName || !runId || !workflowId || !updatedAtText) {
        throw new Error("GitHub workflow_run payload is incomplete");
      }
      const target = (await this.repositories()).find(
        (candidate) =>
          `${candidate.owner}/${candidate.repository}`.toLowerCase() ===
          fullName.toLowerCase(),
      );
      if (!target) {
        await finish("IGNORED", "Repository is not registered");
        return { outcome: "IGNORED", notificationCreated: false };
      }
      const run: WorkflowRun = {
        id: String(runId),
        workflowId: String(workflowId),
        runAttempt: positiveInteger(workflow?.run_attempt) ?? 1,
        name: text(workflow?.name) ?? "GitHub Actions",
        displayTitle:
          text(workflow?.display_title) ??
          text(workflow?.name) ??
          "Workflow run",
        status: text(workflow?.status)?.toLowerCase() ?? "completed",
        conclusion: text(workflow?.conclusion)?.toLowerCase() ?? null,
        headBranch: text(workflow?.head_branch),
        url: text(workflow?.html_url) ?? "",
        updatedAt: new Date(updatedAtText),
      };
      if (!Number.isFinite(run.updatedAt.getTime())) {
        throw new Error("GitHub workflow_run timestamp is invalid");
      }
      let notification: NotificationRecord | null = null;
      await prisma.$transaction(async (transaction) => {
        notification = await this.observeRun(
          transaction,
          target,
          run,
          "WEBHOOK",
          true,
        );
      });
      this.notifications.created(notification);
      await finish("PROCESSED");
      this.polling.configure(OPERATION_ID, {
        enabled: false,
        details: {
          mode: "WEBHOOK",
          lastDeliveryId: deliveryId,
          lastDeliveryAt: new Date().toISOString(),
        },
      });
      void this.prune().catch(() => undefined);
      return {
        outcome: "PROCESSED",
        notificationCreated: Boolean(notification),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finish("ERROR", message);
      throw error;
    }
  }
}
