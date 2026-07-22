import "server-only";

import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";

import type {
  GitHubActionsWorkflowRunView,
  GitHubAutoRetryRuleStatus,
  GitHubAutoRetryRuleView,
  GitHubAutoRetryScope,
  GitHubPipelineState,
  GitHubWorkflowJobView,
  SaveGitHubAutoRetryRuleInput,
} from "./types";
import type { GitHubService } from "./github.service";
import type { PollingService } from "@/services/polling";

const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const MIN_POLL_INTERVAL_SECONDS = 30;
const AMBIGUOUS_ACTION_TIMEOUT_MS = 2 * 60_000;
const FAILURE_STATES = new Set<GitHubPipelineState>([
  "FAILURE",
  "ERROR",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const ACTIVE_STATES = new Set<GitHubPipelineState>([
  "ACTION_REQUIRED",
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
]);
const TERMINAL_EXECUTION_STATES = ["COMPLETED", "EXHAUSTED", "STOPPED"];
const PRIORITY: Record<GitHubAutoRetryScope, number> = {
  WORKFLOW_RUN: 4,
  PULL_REQUEST: 3,
  WORKTREE_BRANCH: 2,
  REPOSITORY: 1,
};
const POLLING_OPERATION_ID = "server:github-auto-retry";

export function autoRetryDecision(input: {
  mode: "COUNT" | "FAILURE";
  retryLimit: number | null;
  automaticRetries: number;
  state: GitHubPipelineState;
}): "RETRY" | "COMPLETE" | "EXHAUSTED" | "STOP" {
  const limitReached =
    input.retryLimit != null && input.automaticRetries >= input.retryLimit;
  if (input.mode === "COUNT") {
    if (input.state !== "SUCCESS") return "STOP";
    return limitReached ? "COMPLETE" : "RETRY";
  }
  if (input.state === "SUCCESS") return "COMPLETE";
  if (!FAILURE_STATES.has(input.state)) return "STOP";
  return limitReached ? "EXHAUSTED" : "RETRY";
}

type RetryRun = GitHubActionsWorkflowRunView & {
  jobs: GitHubWorkflowJobView[];
};

function date(value: Date): string {
  return value.toISOString();
}

function ruleView(rule: {
  id: string;
  scope: string;
  codebaseRepositoryId: string;
  repositoryGithubId: string | null;
  worktreeId: string | null;
  branch: string | null;
  pullRequestNumber: number | null;
  allWorkflows: boolean;
  mode: string;
  retryLimit: number | null;
  failureStrategy: string;
  status: string;
  enabled: boolean;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  targets: Array<{
    id: string;
    workflowId: string | null;
    workflowRunId: string | null;
    jobName: string | null;
  }>;
  executions: Array<{
    id: string;
    workflowRunId: string;
    workflowId: string;
    targetKey: string;
    status: string;
    observedAttempt: number;
    automaticRetries: number;
    lastStatus: string | null;
    lastError: string | null;
    updatedAt: Date;
  }>;
}): GitHubAutoRetryRuleView {
  return {
    ...rule,
    scope: rule.scope as GitHubAutoRetryRuleView["scope"],
    mode: rule.mode as GitHubAutoRetryRuleView["mode"],
    failureStrategy:
      rule.failureStrategy as GitHubAutoRetryRuleView["failureStrategy"],
    status: rule.status as GitHubAutoRetryRuleStatus,
    executions: rule.executions.map((execution) => ({
      ...execution,
      lastStatus:
        execution.lastStatus as GitHubAutoRetryRuleView["executions"][number]["lastStatus"],
      updatedAt: date(execution.updatedAt),
    })),
    createdAt: date(rule.createdAt),
    updatedAt: date(rule.updatedAt),
  };
}

export class GitHubAutoRetryService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollingTickRunning = false;
  private rerunRequested = false;
  private reconciling = false;

  constructor(
    private readonly github: GitHubService,
    private readonly polling?: PollingService,
    startPolling = true,
  ) {
    this.polling?.register({
      id: POLLING_OPERATION_ID,
      kind: "GITHUB_AUTO_RETRY",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
      details: {},
    });
    if (startPolling) queueMicrotask(() => void this.pollReconcile());
  }

  private schedule(seconds: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(MIN_POLL_INTERVAL_SECONDS, seconds) * 1_000;
    this.timer = setTimeout(() => void this.pollReconcile(), delay);
    this.timer.unref();
    this.polling?.schedule(POLLING_OPERATION_ID, new Date(Date.now() + delay));
  }

  configurationChanged(): void {
    if (this.pollingTickRunning) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    queueMicrotask(() => void this.pollReconcile());
  }

  private async pollReconcile(): Promise<void> {
    if (this.pollingTickRunning) return;
    this.pollingTickRunning = true;
    let intervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;
    try {
      const reconcileAtConfiguredCadence = async () => {
        const settings = await (
          await getPrismaClient()
        ).gitHubSettings.upsert({
          where: { id: "default" },
          create: { id: "default" },
          update: {},
        });
        intervalSeconds = settings.actionsNotificationPollIntervalSeconds;
        this.polling?.configure(POLLING_OPERATION_ID, {
          cadenceSeconds: intervalSeconds,
        });
        return this.reconcile();
      };
      if (this.polling) {
        await this.polling.run(
          POLLING_OPERATION_ID,
          reconcileAtConfiguredCadence,
          (activeRules) => ({ activeRules }),
        );
      } else {
        await reconcileAtConfiguredCadence();
      }
    } catch {
      // The coordinator exposes the failure and the next interval retries it.
    } finally {
      this.pollingTickRunning = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        queueMicrotask(() => void this.pollReconcile());
      } else {
        this.schedule(intervalSeconds);
      }
    }
  }

  private include() {
    return {
      targets: { orderBy: { createdAt: "asc" as const } },
      executions: { orderBy: { updatedAt: "desc" as const } },
    };
  }

  async list(input: {
    codebaseRepositoryId?: string | null;
    workflowRunId?: string | null;
  }): Promise<GitHubAutoRetryRuleView[]> {
    const prisma = await getPrismaClient();
    const codebaseRepositoryId = input.codebaseRepositoryId
      ? await this.github.autoRetryRepositoryId(input.codebaseRepositoryId)
      : null;
    const rules = await prisma.gitHubAutoRetryRule.findMany({
      where: {
        ...(codebaseRepositoryId ? { codebaseRepositoryId } : {}),
        ...(input.workflowRunId
          ? { targets: { some: { workflowRunId: input.workflowRunId } } }
          : {}),
      },
      include: this.include(),
      orderBy: { updatedAt: "desc" },
    });
    return rules.map(ruleView);
  }

  private validate(input: SaveGitHubAutoRetryRuleInput): void {
    if (!input.codebaseRepositoryId.trim()) {
      throw new Error("Codebase repository is required");
    }
    if (input.mode === "COUNT" && input.retryLimit == null) {
      throw new Error("Count mode requires a retry limit");
    }
    if (
      input.retryLimit != null &&
      (!Number.isInteger(input.retryLimit) ||
        input.retryLimit < 1 ||
        input.retryLimit > 100)
    ) {
      throw new Error("Retry limit must be an integer from 1 to 100");
    }
    if (input.mode === "FAILURE" && input.retryLimit === undefined) {
      throw new Error("Failure retry limit must be a number or null");
    }
    if (input.scope === "WORKFLOW_RUN") {
      if (
        !input.targets.length ||
        input.targets.some((item) => !item.workflowRunId)
      ) {
        throw new Error("Current-run rules require workflow run targets");
      }
    } else if (!input.allWorkflows && !input.targets.length) {
      throw new Error("Select at least one workflow or choose all workflows");
    }
    if (input.scope === "WORKTREE_BRANCH" && !input.worktreeId) {
      throw new Error("Worktree future rules require a worktree");
    }
    if (input.scope === "PULL_REQUEST" && !input.pullRequestNumber) {
      throw new Error(
        "Pull request future rules require a pull request number",
      );
    }
  }

  async save(
    input: SaveGitHubAutoRetryRuleInput,
  ): Promise<GitHubAutoRetryRuleView> {
    if (!(await this.github.autoRetryCredentialsReady())) {
      throw new Error(
        "A GitHub token and verified GitHub App with Actions write access are required",
      );
    }
    input = {
      ...input,
      codebaseRepositoryId: await this.github.autoRetryRepositoryId(
        input.codebaseRepositoryId,
      ),
    };
    this.validate(input);
    const prisma = await getPrismaClient();
    let branch = input.branch?.trim() || null;
    if (input.scope === "WORKTREE_BRANCH" && input.worktreeId) {
      const worktree = await prisma.worktree.findUnique({
        where: { id: input.worktreeId },
        select: { branch: true },
      });
      branch = worktree?.branch ?? null;
      if (!branch) throw new Error("The worktree does not have a branch");
    }

    const possibleConflicts = await prisma.gitHubAutoRetryRule.findMany({
      where: {
        id: input.id ? { not: input.id } : undefined,
        enabled: true,
        scope: input.scope,
        codebaseRepositoryId: input.codebaseRepositoryId,
      },
      include: { targets: true },
    });
    const runIds = new Set(
      input.targets
        .map((target) => target.workflowRunId)
        .filter((value): value is string => Boolean(value)),
    );
    const conflict = possibleConflicts.find((candidate) => {
      if (input.scope === "WORKFLOW_RUN") {
        return candidate.targets.some(
          (target) => target.workflowRunId && runIds.has(target.workflowRunId),
        );
      }
      if (input.scope === "WORKTREE_BRANCH") {
        return candidate.branch === branch;
      }
      if (input.scope === "PULL_REQUEST") {
        return candidate.pullRequestNumber === input.pullRequestNumber;
      }
      return true;
    });
    if (conflict) {
      throw new Error(
        "An enabled Auto Retry rule already exists for this scope",
      );
    }

    const id = input.id ?? randomUUID();
    const rule = await prisma.$transaction(async (tx) => {
      await tx.gitHubAutoRetryRule.upsert({
        where: { id },
        create: {
          id,
          scope: input.scope,
          codebaseRepositoryId: input.codebaseRepositoryId,
          repositoryGithubId: input.repositoryGithubId ?? null,
          worktreeId: input.worktreeId ?? null,
          branch,
          pullRequestNumber: input.pullRequestNumber ?? null,
          allWorkflows: input.allWorkflows,
          mode: input.mode,
          retryLimit: input.retryLimit ?? null,
          failureStrategy: input.failureStrategy,
          status: "ACTIVE",
          enabled: true,
        },
        update: {
          scope: input.scope,
          codebaseRepositoryId: input.codebaseRepositoryId,
          repositoryGithubId: input.repositoryGithubId ?? null,
          worktreeId: input.worktreeId ?? null,
          branch,
          pullRequestNumber: input.pullRequestNumber ?? null,
          allWorkflows: input.allWorkflows,
          mode: input.mode,
          retryLimit: input.retryLimit ?? null,
          failureStrategy: input.failureStrategy,
          status: "ACTIVE",
          enabled: true,
          lastError: null,
          activatedAt: new Date(),
        },
      });
      await tx.gitHubAutoRetryTarget.deleteMany({ where: { ruleId: id } });
      if (input.targets.length) {
        await tx.gitHubAutoRetryTarget.createMany({
          data: input.targets.map((target) => ({
            id: randomUUID(),
            ruleId: id,
            workflowId: target.workflowId?.trim() || null,
            workflowRunId: target.workflowRunId?.trim() || null,
            jobName: target.jobName?.trim() || null,
          })),
        });
      }
      await tx.gitHubAutoRetryExecution.deleteMany({ where: { ruleId: id } });
      return tx.gitHubAutoRetryRule.findUniqueOrThrow({
        where: { id },
        include: this.include(),
      });
    });
    queueMicrotask(() => void this.reconcile().catch(() => undefined));
    return ruleView(rule);
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<GitHubAutoRetryRuleView> {
    const prisma = await getPrismaClient();
    const rule = await prisma.$transaction(async (tx) => {
      if (enabled) {
        await tx.gitHubAutoRetryExecution.updateMany({
          where: { ruleId: id, pendingFromAttempt: { not: null } },
          data: {
            pendingFromAttempt: null,
            observedAttempt: 0,
            status: "WATCHING",
            lastError: null,
            finishedAt: null,
          },
        });
      }
      return tx.gitHubAutoRetryRule.update({
        where: { id },
        data: {
          enabled,
          status: enabled ? "ACTIVE" : "PAUSED",
          lastError: null,
          ...(enabled ? { activatedAt: new Date() } : {}),
        },
        include: this.include(),
      });
    });
    if (enabled)
      queueMicrotask(() => void this.reconcile().catch(() => undefined));
    return ruleView(rule);
  }

  async delete(id: string): Promise<boolean> {
    const result = await (
      await getPrismaClient()
    ).gitHubAutoRetryRule.deleteMany({ where: { id } });
    return result.count > 0;
  }

  private matches(
    rule: {
      scope: string;
      branch: string | null;
      pullRequestNumber: number | null;
      activatedAt: Date;
    },
    run: RetryRun,
    tracked = false,
  ): boolean {
    if (rule.scope !== "WORKFLOW_RUN") {
      const active = ACTIVE_STATES.has(run.status);
      if (
        !tracked &&
        !active &&
        Date.parse(run.createdAt) < rule.activatedAt.getTime()
      ) {
        return false;
      }
    }
    if (rule.scope === "WORKTREE_BRANCH") return run.headBranch === rule.branch;
    if (rule.scope === "PULL_REQUEST") {
      return run.pullRequests.some(
        (pullRequest) => pullRequest.number === rule.pullRequestNumber,
      );
    }
    return true;
  }

  private async execution(ruleId: string, run: RetryRun, targetKey: string) {
    const prisma = await getPrismaClient();
    return prisma.gitHubAutoRetryExecution.upsert({
      where: {
        ruleId_workflowRunId_targetKey: {
          ruleId,
          workflowRunId: run.id,
          targetKey,
        },
      },
      create: {
        id: randomUUID(),
        ruleId,
        workflowRunId: run.id,
        workflowId: run.workflowId,
        targetKey,
      },
      update: {},
    });
  }

  private targetKeys(
    rule: {
      allWorkflows: boolean;
      mode: string;
      failureStrategy: string;
      targets: Array<{
        workflowId: string | null;
        workflowRunId: string | null;
        jobName: string | null;
      }>;
    },
    run: RetryRun,
  ): string[] {
    if (rule.allWorkflows) return ["workflow"];
    const targets = rule.targets.filter(
      (target) =>
        target.workflowRunId === run.id || target.workflowId === run.workflowId,
    );
    if (
      targets.some((target) => !target.jobName) ||
      (rule.mode === "FAILURE" && rule.failureStrategy === "ALL_JOBS")
    ) {
      return ["workflow"];
    }
    return targets.flatMap((target) =>
      target.jobName ? [`job:${target.jobName}`] : [],
    );
  }

  private async finishExecution(
    id: string,
    run: RetryRun,
    status: string,
  ): Promise<void> {
    await (
      await getPrismaClient()
    ).gitHubAutoRetryExecution.update({
      where: { id },
      data: {
        status,
        observedAttempt: run.runAttempt,
        lastStatus: run.status,
        pendingFromAttempt: null,
        finishedAt: new Date(),
        lastError: null,
      },
    });
  }

  private async trigger(
    rule: { id: string; codebaseRepositoryId: string },
    execution: {
      id: string;
      automaticRetries: number;
    },
    run: RetryRun,
    action: "ALL_JOBS" | "FAILED_JOBS" | "JOB",
    jobId: string | null,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.gitHubAutoRetryExecution.update({
      where: { id: execution.id },
      data: {
        status: "RETRYING",
        pendingFromAttempt: run.runAttempt,
        observedAttempt: run.runAttempt,
        lastStatus: run.status,
        lastError: null,
      },
    });
    try {
      await this.github.autoRetryRerun(
        rule.codebaseRepositoryId,
        run.id,
        action,
        jobId,
        {
          actor: "auto-retry",
          ipAddress: null,
          autoRetryRuleId: rule.id,
          autoRetryExecutionId: execution.id,
        },
      );
      await prisma.gitHubAutoRetryExecution.update({
        where: { id: execution.id },
        data: {
          automaticRetries: { increment: 1 },
          lastError: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.gitHubAutoRetryExecution.update({
        where: { id: execution.id },
        data: { lastError: message },
      });
      await prisma.gitHubAutoRetryRule.update({
        where: { id: rule.id },
        data: { lastError: message },
      });
    }
  }

  private async reconcileExecution(
    rule: {
      id: string;
      codebaseRepositoryId: string;
      mode: string;
      retryLimit: number | null;
      failureStrategy: string;
    },
    run: RetryRun,
    targetKey: string,
    job: GitHubWorkflowJobView | null,
  ): Promise<boolean> {
    const execution = await this.execution(rule.id, run, targetKey);
    if (execution.pendingFromAttempt != null) {
      if (run.runAttempt > execution.pendingFromAttempt) {
        await (
          await getPrismaClient()
        ).gitHubAutoRetryExecution.update({
          where: { id: execution.id },
          data: {
            pendingFromAttempt: null,
            status: "WATCHING",
            lastError: null,
          },
        });
      } else if (
        Date.now() - execution.updatedAt.getTime() <
        AMBIGUOUS_ACTION_TIMEOUT_MS
      ) {
        return false;
      } else {
        const prisma = await getPrismaClient();
        const message =
          "GitHub did not report a new attempt after the rerun request; automatic retries are paused to prevent a duplicate rerun";
        await prisma.$transaction(async (tx) => {
          await tx.gitHubAutoRetryExecution.update({
            where: { id: execution.id },
            data: { status: "ERROR", lastError: message },
          });
          await tx.gitHubAutoRetryRule.update({
            where: { id: rule.id },
            data: {
              enabled: false,
              status: "PAUSED",
              lastError: message,
            },
          });
        });
        return false;
      }
    }
    if (
      execution.observedAttempt === run.runAttempt &&
      execution.pendingFromAttempt == null
    ) {
      return false;
    }

    const state = job?.status ?? run.status;
    const decision = autoRetryDecision({
      mode: rule.mode as "COUNT" | "FAILURE",
      retryLimit: rule.retryLimit,
      automaticRetries: execution.automaticRetries,
      state,
    });
    if (decision === "COMPLETE") {
      await this.finishExecution(execution.id, run, "COMPLETED");
      return false;
    }
    if (decision === "EXHAUSTED") {
      await this.finishExecution(execution.id, run, "EXHAUSTED");
      return false;
    }
    if (decision === "STOP") {
      await this.finishExecution(execution.id, run, "STOPPED");
      return false;
    }
    if (rule.mode === "COUNT") {
      await this.trigger(
        rule,
        execution,
        run,
        job ? "JOB" : "ALL_JOBS",
        job?.id ?? null,
      );
      return true;
    }

    await this.trigger(
      rule,
      execution,
      run,
      job
        ? rule.failureStrategy === "ALL_JOBS"
          ? "ALL_JOBS"
          : "JOB"
        : rule.failureStrategy === "ALL_JOBS"
          ? "ALL_JOBS"
          : "FAILED_JOBS",
      job?.id ?? null,
    );
    return true;
  }

  async reconcile(): Promise<number> {
    if (this.reconciling) return 0;
    this.reconciling = true;
    let activeRuleCount = 0;
    try {
      const prisma = await getPrismaClient();
      const rules = await prisma.gitHubAutoRetryRule.findMany({
        where: { enabled: true, status: "ACTIVE" },
        include: { targets: true },
        orderBy: { createdAt: "asc" },
      });
      activeRuleCount = rules.length;
      const runsByRepository = new Map<string, RetryRun[]>();
      const trackedExecutions = rules.length
        ? await prisma.gitHubAutoRetryExecution.findMany({
            where: {
              ruleId: { in: rules.map((rule) => rule.id) },
              status: { notIn: TERMINAL_EXECUTION_STATES },
            },
            select: { ruleId: true, workflowRunId: true },
          })
        : [];
      const trackedRunIdsByRule = new Map<string, Set<string>>();
      for (const execution of trackedExecutions) {
        const ids = trackedRunIdsByRule.get(execution.ruleId) ?? new Set();
        ids.add(execution.workflowRunId);
        trackedRunIdsByRule.set(execution.ruleId, ids);
      }
      const selected = new Map<
        string,
        { rule: (typeof rules)[number]; run: RetryRun }
      >();

      for (const rule of rules) {
        let runs = runsByRepository.get(rule.codebaseRepositoryId);
        if (!runs) {
          try {
            runs = await this.github.autoRetryRuns(rule.codebaseRepositoryId);
            runsByRepository.set(rule.codebaseRepositoryId, runs);
          } catch (error) {
            await prisma.gitHubAutoRetryRule.update({
              where: { id: rule.id },
              data: {
                lastError:
                  error instanceof Error ? error.message : String(error),
              },
            });
            continue;
          }
        }
        const exactRunIds = new Set(
          rule.targets
            .map((target) => target.workflowRunId)
            .filter((value): value is string => Boolean(value)),
        );
        const trackedRunIds = trackedRunIdsByRule.get(rule.id) ?? new Set();
        const directRunIds = new Set([...exactRunIds, ...trackedRunIds]);
        for (const workflowRunId of directRunIds) {
          if (runs.some((run) => run.id === workflowRunId)) continue;
          try {
            runs.push(
              await this.github.autoRetryRun(
                rule.codebaseRepositoryId,
                workflowRunId,
                false,
              ),
            );
          } catch (error) {
            await prisma.gitHubAutoRetryRule.update({
              where: { id: rule.id },
              data: {
                lastError:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
        for (const run of runs) {
          if (rule.scope === "WORKFLOW_RUN" && !exactRunIds.has(run.id))
            continue;
          if (!this.matches(rule, run, trackedRunIds.has(run.id))) continue;
          if (
            !rule.allWorkflows &&
            !rule.targets.some(
              (target) =>
                target.workflowRunId === run.id ||
                target.workflowId === run.workflowId,
            )
          ) {
            continue;
          }
          const current = selected.get(run.id);
          if (
            !current ||
            PRIORITY[rule.scope as GitHubAutoRetryScope] >
              PRIORITY[current.rule.scope as GitHubAutoRetryScope]
          ) {
            selected.set(run.id, { rule, run });
          }
        }
      }

      for (const { rule, run: discoveredRun } of selected.values()) {
        const targetKeys = this.targetKeys(rule, discoveredRun);
        if (ACTIVE_STATES.has(discoveredRun.status)) {
          await Promise.all(
            targetKeys.map((targetKey) =>
              this.execution(rule.id, discoveredRun, targetKey),
            ),
          );
          continue;
        }
        let run = discoveredRun;
        const targets = rule.allWorkflows
          ? [{ jobName: null }]
          : rule.targets.filter(
              (target) =>
                target.workflowRunId === run.id ||
                target.workflowId === run.workflowId,
            );
        const wholeWorkflow = targets.some((target) => !target.jobName);
        if (wholeWorkflow) {
          await this.reconcileExecution(rule, run, "workflow", null);
          continue;
        }
        const executions = await Promise.all(
          targetKeys.map((targetKey) =>
            this.execution(rule.id, run, targetKey),
          ),
        );
        const needsJobs = executions.some(
          (execution) =>
            execution.observedAttempt !== run.runAttempt ||
            (execution.pendingFromAttempt != null &&
              run.runAttempt > execution.pendingFromAttempt),
        );
        if (!needsJobs) {
          for (let index = 0; index < executions.length; index += 1) {
            if (executions[index]?.pendingFromAttempt != null) {
              await this.reconcileExecution(
                rule,
                run,
                targetKeys[index]!,
                null,
              );
            }
          }
          continue;
        }
        try {
          run = await this.github.autoRetryRun(
            rule.codebaseRepositoryId,
            run.id,
          );
        } catch (error) {
          await prisma.gitHubAutoRetryRule.update({
            where: { id: rule.id },
            data: {
              lastError: error instanceof Error ? error.message : String(error),
            },
          });
          continue;
        }
        if (rule.mode === "FAILURE" && rule.failureStrategy === "ALL_JOBS") {
          const selectedJobs = run.jobs.filter((job) =>
            targets.some((target) => target.jobName === job.name),
          );
          const representative =
            selectedJobs.find((job) => FAILURE_STATES.has(job.status)) ??
            selectedJobs.find((job) => job.status !== "SUCCESS") ??
            selectedJobs[0];
          if (representative) {
            await this.reconcileExecution(
              rule,
              run,
              "workflow",
              representative,
            );
          } else if (executions[0]) {
            await this.finishExecution(executions[0].id, run, "STOPPED");
          }
          continue;
        }
        const executionByTargetKey = new Map(
          targetKeys.map((targetKey, index) => [targetKey, executions[index]]),
        );
        for (const target of targets) {
          const job = run.jobs.find((item) => item.name === target.jobName);
          if (!job) {
            const execution = executionByTargetKey.get(`job:${target.jobName}`);
            if (execution) {
              await this.finishExecution(execution.id, run, "STOPPED");
            }
            continue;
          }
          const triggered = await this.reconcileExecution(
            rule,
            run,
            `job:${job.name}`,
            job,
          );
          if (triggered) break;
        }
      }

      for (const rule of rules.filter(
        (item) => item.scope === "WORKFLOW_RUN",
      )) {
        const executions = await prisma.gitHubAutoRetryExecution.findMany({
          where: { ruleId: rule.id },
          select: { status: true },
        });
        if (
          executions.length > 0 &&
          executions.every((execution) =>
            TERMINAL_EXECUTION_STATES.includes(execution.status),
          )
        ) {
          await prisma.gitHubAutoRetryRule.update({
            where: { id: rule.id },
            data: {
              enabled: false,
              status: executions.some((item) => item.status === "EXHAUSTED")
                ? "EXHAUSTED"
                : "COMPLETED",
            },
          });
        }
      }
    } finally {
      this.reconciling = false;
    }
    return activeRuleCount;
  }
}
