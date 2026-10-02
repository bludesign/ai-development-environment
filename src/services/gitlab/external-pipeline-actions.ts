import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { getPrismaClient } from "@/data/prisma-client";
import type {
  ExternalPipelineExecution,
  PrismaClient,
} from "@/generated/prisma/client";
import { CredentialService } from "@/services/credentials";
import {
  CREDENTIAL_KINDS,
  externalPipelineSecretCredential,
} from "@/services/credentials/types";
import {
  MAX_SCRIPT_LENGTH,
  runScript,
  ScriptExecutionError,
  createScriptRedactor,
} from "@/services/scripts/runtime";
import type { GitLabJobView, GitLabPipelineView } from "./types";

export type ExternalAction = "RETRY" | "CANCEL";
export type ActionOrigin = "MANUAL" | "AUTOMATIC" | "WORKFLOW" | "MCP";
export const externalRetryStates = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELED",
  "SKIPPED",
]);
export const activeStates = new Set([
  "CREATED",
  "WAITING_FOR_RESOURCE",
  "PREPARING",
  "PENDING",
  "RUNNING",
  "WAITING_FOR_CALLBACK",
  "SCHEDULED",
]);
export function eligibleExternalJob(
  job: GitLabJobView,
  action: ExternalAction,
  automatic = false,
): boolean {
  return (
    job.kind === "EXTERNAL" &&
    !job.retried &&
    (action === "CANCEL"
      ? activeStates.has(job.status)
      : automatic
        ? job.status === "FAILED" || job.status === "CANCELED"
        : externalRetryStates.has(job.status))
  );
}
export const hashActionKey = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const externalIdentity = (
  repositoryId: string,
  pipeline: GitLabPipelineView,
  job: GitLabJobView,
) =>
  hashActionKey([
    repositoryId,
    pipeline.projectId,
    pipeline.sha,
    pipeline.branch,
    job.name,
    job.author?.id ?? null,
  ]);
export const externalObservation = (job: GitLabJobView) =>
  hashActionKey([job.id, job.status, job.finishedAt, job.startedAt]);
function executionView(row: ExternalPipelineExecution) {
  return {
    ...row,
    targetedStatusIds: JSON.parse(row.targetedStatusIdsJson) as string[],
    output: row.outputJson,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export class ExternalPipelineActionsService {
  constructor(
    private readonly prismaFactory: () => Promise<PrismaClient> = getPrismaClient,
    private readonly credentials = new CredentialService(),
    private readonly runner = runScript,
  ) {}
  async repositoryForProject(projectId: string) {
    const prisma = await this.prismaFactory();
    const project = await prisma.gitLabProject.findUnique({
      where: { id: projectId },
    });
    if (!project) return null;
    const repository = await prisma.codebaseRepository.findUnique({
      where: {
        canonicalOrigin: normalizeGitOrigin(project.webUrl).canonicalOrigin,
      },
    });
    return repository ? { repository, project } : null;
  }
  async configuration(repositoryId: string) {
    const prisma = await this.prismaFactory();
    if (
      !(await prisma.codebaseRepository.findUnique({
        where: { id: repositoryId },
        select: { id: true },
      }))
    )
      throw new Error("Repository not found");
    const [config, names] = await Promise.all([
      prisma.externalPipelineActions.findUnique({ where: { repositoryId } }),
      prisma.credential.findMany({
        where: {
          kind: CREDENTIAL_KINDS.externalPipelineSecret,
          ownerId: repositoryId,
        },
        select: { id: true },
        orderBy: { id: "asc" },
      }),
    ]);
    return {
      repositoryId,
      enabled: config?.enabled ?? false,
      retryScript: config?.retryScript ?? "",
      cancelScript: config?.cancelScript ?? "",
      secretNames: names.map(({ id }) =>
        decodeURIComponent(id.split("/").at(-1)!),
      ),
      updatedAt: config?.updatedAt.toISOString() ?? null,
    };
  }
  async saveConfiguration(
    repositoryId: string,
    input: { enabled: boolean; retryScript: string; cancelScript: string },
  ) {
    await this.configuration(repositoryId);
    for (const source of [input.retryScript, input.cancelScript])
      if (source.length > MAX_SCRIPT_LENGTH)
        throw new Error("Script must be 100,000 characters or fewer");
    const prisma = await this.prismaFactory();
    await prisma.externalPipelineActions.upsert({
      where: { repositoryId },
      create: { repositoryId, ...input },
      update: input,
    });
    return this.configuration(repositoryId);
  }
  async setSecret(repositoryId: string, name: string, value: string | null) {
    await this.configuration(repositoryId);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
      throw new Error(
        "Secret names must start with a letter or underscore and contain only letters, digits, and underscores (up to 128 characters)",
      );
    const descriptor = externalPipelineSecretCredential(repositoryId, name);
    if (value === null)
      await this.credentials.setAndDeleteMany([], [descriptor]);
    else {
      if (!value || value.length > 65_536)
        throw new Error("Secret values must contain 1–65,536 characters");
      await this.credentials.set(descriptor, Buffer.from(value));
    }
    return this.configuration(repositoryId);
  }
  async executions(projectId: string, pipelineId: string) {
    const prisma = await this.prismaFactory();
    const rows = await prisma.externalPipelineExecution.findMany({
      where: { projectId, pipelineId },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    return rows.map(executionView);
  }
  async preflight(
    projectId: string,
    action: ExternalAction,
    jobs: GitLabJobView[],
  ) {
    const match = await this.repositoryForProject(projectId);
    if (!jobs.length) return match;
    if (!match)
      throw new Error(
        "External pipeline actions require a matching canonical repository",
      );
    const config = await this.configuration(match.repository.id);
    const source =
      action === "RETRY" ? config.retryScript : config.cancelScript;
    if (!config.enabled || !source.trim())
      throw new Error(
        `Configure and enable the external pipeline ${action.toLowerCase()} script in repository settings before requesting this action`,
      );
    return { ...match, config, source };
  }
  async execute(input: {
    projectId: string;
    pipeline: GitLabPipelineView;
    jobs: GitLabJobView[];
    selectedJob?: GitLabJobView;
    action: ExternalAction;
    origin: ActionOrigin;
    native?: () => Promise<unknown>;
    baseUrl: string;
  }) {
    const { pipeline, action, origin, jobs } = input;
    const match = await this.preflight(input.projectId, action, jobs);
    if (!match) throw new Error("Repository not found for pipeline action");
    const prisma = await this.prismaFactory();
    const secrets: Record<string, string> = Object.create(null);
    if ("config" in match)
      for (const name of match.config.secretNames) {
        const value = await this.credentials.getText(
          externalPipelineSecretCredential(match.repository.id, name),
        );
        if (value === null)
          throw new Error(
            `External pipeline secret ${name} is unavailable from the configured credential store`,
          );
        secrets[name] = value;
      }
    const redact = createScriptRedactor(Object.values(secrets));
    // Each observed status is claimed separately so pipeline and individual actions overlap.
    const keys = [
      ...new Set(
        jobs.map((job) =>
          hashActionKey([
            externalIdentity(match.repository.id, pipeline, job),
            action,
            externalObservation(job),
          ]),
        ),
      ),
    ];
    const id = randomUUID();
    let nativeStatus = "NOT_REQUESTED",
      externalStatus = "NOT_REQUESTED";
    let previousOutput: string | null = null;
    const executionData = {
      id,
      repositoryId: match.repository.id,
      projectId: input.projectId,
      pipelineId: pipeline.id,
      action,
      origin,
      status: "RUNNING",
      targetedStatusIdsJson: JSON.stringify(jobs.map((job) => job.id)),
    };
    try {
      await prisma.$transaction(async (tx) => {
        for (const key of keys)
          await tx.externalPipelineActionClaim.create({
            data: { key, executionId: id },
          });
        await tx.externalPipelineExecution.create({ data: executionData });
      });
    } catch (error) {
      const claim = await prisma.externalPipelineActionClaim.findFirst({
        where: { key: { in: keys } },
      });
      if (!claim) throw error;
      const existing = await prisma.externalPipelineExecution.findUniqueOrThrow(
        { where: { id: claim.executionId } },
      );
      if (
        (existing.externalStatus === "FAILED" ||
          (input.native && existing.nativeStatus === "FAILED")) &&
        existing.status !== "RUNNING"
      ) {
        // Retry only the failed component; preserve an already accepted native request.
        const reclaimed = await prisma.$transaction(async (tx) => {
          for (const key of keys) {
            const previous = await tx.externalPipelineActionClaim.findUnique({
              where: { key },
            });
            if (previous && previous.executionId !== existing.id) return false;
          }
          for (const key of keys)
            await tx.externalPipelineActionClaim.upsert({
              where: { key },
              create: { key, executionId: id },
              update: { executionId: id },
            });
          await tx.externalPipelineExecution.create({ data: executionData });
          return true;
        });
        if (reclaimed) {
          nativeStatus = ["ACCEPTED", "UNCERTAIN"].includes(
            existing.nativeStatus,
          )
            ? existing.nativeStatus
            : "NOT_REQUESTED";
          externalStatus = ["ACCEPTED", "UNCERTAIN"].includes(
            existing.externalStatus,
          )
            ? existing.externalStatus
            : "NOT_REQUESTED";
          previousOutput = existing.outputJson;
        } else return executionView(existing);
      } else {
        // A process can die after sending a request. A stale claim has an uncertain outcome.
        if (
          existing.status === "RUNNING" &&
          Date.now() - existing.startedAt.getTime() > 90_000
        )
          await prisma.externalPipelineExecution.update({
            where: { id: existing.id },
            data: {
              status: "UNCERTAIN",
              externalStatus: "UNCERTAIN",
              message:
                "The previous request did not finish. Await provider updates before retrying.",
              completedAt: new Date(),
            },
          });
        return executionView(
          await prisma.externalPipelineExecution.findUniqueOrThrow({
            where: { id: existing.id },
          }),
        );
      }
    }
    const errors: string[] = [];
    let output: unknown = previousOutput ? JSON.parse(previousOutput) : null;
    if (action === "CANCEL" && origin !== "AUTOMATIC")
      for (const job of jobs)
        await prisma.externalPipelineCancellation.upsert({
          where: {
            identityKey: externalIdentity(match.repository.id, pipeline, job),
          },
          create: {
            identityKey: externalIdentity(match.repository.id, pipeline, job),
            statusId: job.id,
            targetUrl: job.targetUrl,
          },
          update: {
            statusId: job.id,
            targetUrl: job.targetUrl,
            canceledAt: new Date(),
          },
        });
    if (input.native && nativeStatus === "NOT_REQUESTED") {
      try {
        await input.native();
        nativeStatus = "ACCEPTED";
      } catch (error) {
        nativeStatus = /timeout|timed out|aborted/i.test(
          error instanceof Error ? error.message : String(error),
        )
          ? "UNCERTAIN"
          : "FAILED";
        errors.push(
          `GitLab: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 10_000)}`,
        );
      }
      await prisma.externalPipelineExecution.update({
        where: { id },
        data: { nativeStatus },
      });
    }
    if (
      jobs.length &&
      "source" in match &&
      externalStatus === "NOT_REQUESTED"
    ) {
      const mergeRequests = pipeline.mergeRequests.filter((mr) =>
        pipeline.ref.match(/^refs\/merge-requests\/(\d+)\//)
          ? mr.iid === Number(pipeline.ref.split("/")[2]) &&
            mr.projectId === input.projectId
          : mr.sourceBranch === pipeline.branch,
      );
      const context = {
        version: 1,
        action: action.toLowerCase(),
        origin: origin.toLowerCase(),
        repository: {
          id: match.repository.id,
          name: match.repository.name,
          canonicalOrigin: match.repository.canonicalOrigin,
        },
        gitlab: { baseUrl: input.baseUrl },
        project: {
          id: match.project.id,
          name: match.project.name,
          pathWithNamespace: match.project.pathWithNamespace,
          webUrl: match.project.webUrl,
        },
        pipeline: {
          ...pipeline,
          rawRef: pipeline.ref,
          resolvedBranch: pipeline.branch,
        },
        externalJobs: jobs,
        job: input.selectedJob ?? null,
        mergeRequest: mergeRequests.length === 1 ? mergeRequests[0] : null,
        mergeRequests,
        secrets,
      };
      try {
        const result = await this.runner({
          source: match.source,
          context,
          mode: "external",
          secrets: Object.values(secrets),
          timeoutMs: 30_000,
          fetchTimeoutMs: 15_000,
          memoryLimitMb: 32,
        });
        output = {
          result: result.result,
          console: result.console,
          durationMs: result.durationMs,
        };
        externalStatus = "ACCEPTED";
      } catch (error) {
        externalStatus =
          error instanceof ScriptExecutionError && error.uncertain
            ? "UNCERTAIN"
            : "FAILED";
        errors.push(
          `External: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 10_000)}`,
        );
        output = {
          console: error instanceof ScriptExecutionError ? error.console : [],
        };
      }
    }
    if (action === "CANCEL" && externalStatus === "FAILED")
      for (const job of jobs)
        await prisma.externalPipelineCancellation.deleteMany({
          where: {
            identityKey: externalIdentity(match.repository.id, pipeline, job),
            statusId: job.id,
          },
        });
    if (
      action === "RETRY" &&
      origin !== "AUTOMATIC" &&
      ["ACCEPTED", "UNCERTAIN"].includes(externalStatus)
    )
      for (const job of jobs)
        await prisma.externalPipelineCancellation.deleteMany({
          where: {
            identityKey: externalIdentity(match.repository.id, pipeline, job),
          },
        });
    const statuses = [nativeStatus, externalStatus].filter(
      (value) => value !== "NOT_REQUESTED",
    );
    const status = statuses.every((value) => value === "ACCEPTED")
      ? "ACCEPTED"
      : statuses.includes("ACCEPTED")
        ? "PARTIAL"
        : statuses.includes("UNCERTAIN")
          ? "UNCERTAIN"
          : "FAILED";
    await prisma.externalPipelineExecution.update({
      where: { id },
      data: {
        status,
        nativeStatus,
        externalStatus,
        message: errors.length
          ? errors.join("; ")
          : "Action request completed; awaiting provider status updates",
        outputJson: JSON.stringify(output),
        completedAt: new Date(),
      },
    });

    return executionView(
      await prisma.externalPipelineExecution.findUniqueOrThrow({
        where: { id },
      }),
    );
  }
  async ruleApplies(
    rule: { id: string; pipelineId: string | null },
    pipeline: GitLabPipelineView,
    jobs: GitLabJobView[],
  ) {
    if (!rule.pipelineId || rule.pipelineId === pipeline.id) return true;
    const match = await this.repositoryForProject(pipeline.projectId);
    if (!match) return false;
    const prisma = await this.prismaFactory();
    return !!(await prisma.externalPipelineRetryState.count({
      where: {
        ruleId: rule.id,
        identityKey: {
          in: jobs
            .filter((job) => job.kind === "EXTERNAL")
            .map((job) => externalIdentity(match.repository.id, pipeline, job)),
        },
      },
    }));
  }
  async automaticJobs(
    rule: { id: string; maxAttempts: number },
    pipeline: GitLabPipelineView,
    jobs: GitLabJobView[],
  ) {
    const match = await this.repositoryForProject(pipeline.projectId);
    if (!match) return [];
    const prisma = await this.prismaFactory();
    const eligible: GitLabJobView[] = [];
    for (const job of jobs.filter((job) =>
      eligibleExternalJob(job, "RETRY", true),
    )) {
      const identityKey = externalIdentity(match.repository.id, pipeline, job);
      const cancellation = await prisma.externalPipelineCancellation.findUnique(
        { where: { identityKey } },
      );
      if (
        cancellation &&
        (cancellation.statusId === job.id ||
          (!!cancellation.targetUrl &&
            cancellation.targetUrl === job.targetUrl) ||
          (job.status === "CANCELED" &&
            !cancellation.targetUrl &&
            !job.targetUrl) ||
          !job.createdAt ||
          new Date(job.createdAt) <= cancellation.canceledAt)
      )
        continue;
      const key = hashActionKey([rule.id, identityKey]);
      const observationKey = hashActionKey([key, externalObservation(job)]);
      const actionClaim = await prisma.externalPipelineActionClaim.findUnique({
        where: {
          key: hashActionKey([identityKey, "RETRY", externalObservation(job)]),
        },
      });
      if (actionClaim) {
        const execution = await prisma.externalPipelineExecution.findUnique({
          where: { id: actionClaim.executionId },
        });
        if (
          execution &&
          ["RUNNING", "ACCEPTED", "UNCERTAIN"].includes(
            execution.externalStatus === "NOT_REQUESTED"
              ? execution.status
              : execution.externalStatus,
          )
        )
          continue;
      }
      const claimed = await prisma.$transaction(async (tx) => {
        const observation =
          await tx.externalPipelineRetryObservation.findUnique({
            where: { key: observationKey },
          });
        if (observation && observation.status !== "FAILED") return false;
        await tx.externalPipelineRetryState.upsert({
          where: { key },
          create: { key, ruleId: rule.id, identityKey },
          update: {},
        });
        const incremented = await tx.externalPipelineRetryState.updateMany({
          where: { key, attempts: { lt: rule.maxAttempts } },
          data: {
            attempts: { increment: 1 },
            observedKey: externalObservation(job),
            awaitingUpdate: true,
          },
        });
        if (!incremented.count) return false;
        await tx.externalPipelineRetryObservation.upsert({
          where: { key: observationKey },
          create: { key: observationKey, stateKey: key },
          update: { status: "CLAIMED" },
        });
        return true;
      });
      if (claimed) eligible.push(job);
    }
    return eligible;
  }
  async finishAutomatic(
    ruleId: string,
    pipeline: GitLabPipelineView,
    jobs: GitLabJobView[],
    status: string,
  ) {
    const match = await this.repositoryForProject(pipeline.projectId);
    if (!match) return;
    const prisma = await this.prismaFactory();
    for (const job of jobs) {
      const stateKey = hashActionKey([
        ruleId,
        externalIdentity(match.repository.id, pipeline, job),
      ]);
      await prisma.externalPipelineRetryObservation.updateMany({
        where: { key: hashActionKey([stateKey, externalObservation(job)]) },
        data: { status },
      });
      await prisma.externalPipelineRetryState.updateMany({
        where: { key: stateKey },
        data: { awaitingUpdate: status !== "FAILED" },
      });
    }
  }
}
export const externalPipelineActionsService =
  new ExternalPipelineActionsService();
