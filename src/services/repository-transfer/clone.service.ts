import { createHash, randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  CODEBASE_CLONE_JOB_KIND,
  CODEBASE_CLONE_INSPECT_JOB_KIND,
  normalizeGitOrigin,
  parseCodebaseSnapshot,
  validateCloneRelativePath,
  validateCloneRemote,
} from "@ai-development-environment/agent-contract/codebases";

import { getPrismaClient } from "@/data/prisma-client";
import type { Agent, AgentJob, Prisma } from "@/generated/prisma/client";
import {
  AgentControlService,
  agentOnlineWindowMs,
  agentEventBus,
  agentJobChangedTopic,
  CODEBASE_CHANGED_TOPIC,
} from "@/services/agent-control";

export type RepositoryCloneDestination = {
  repositoryKey: string;
  repositoryId?: string | null;
  agentId: string;
  remoteUrl: string;
  relativePath?: string | null;
};

export type RepositoryClonePreview = Omit<
  RepositoryCloneDestination,
  "repositoryId" | "relativePath"
> & {
  repositoryId: string | null;
  agentName: string;
  baseDirectory: string;
  relativePath: string;
  destinationPath: string;
  codebaseId: string | null;
  status: "READY" | "REUSE" | "BLOCKED";
  error: string | null;
};

const terminal = new Set([
  "SUCCEEDED",
  "REUSED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "BLOCKED",
]);
const operationInclude = {
  items: { orderBy: { createdAt: "asc" as const } },
} as const;
const topic = (id: string) => `repository-transfer.${id}.changed`;

function problem(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_000,
  );
}

function eligibility(agent: Agent): string | null {
  if (!agent.baseRepoDirectory)
    return "Set this agent's Base repository directory first";
  if (
    !agent.lastSeenAt ||
    agent.disconnectedAt ||
    Date.now() - agent.lastSeenAt.getTime() > agentOnlineWindowMs(agent)
  )
    return "Agent is offline";
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(agent.capabilitiesJson);
  } catch {
    capabilities = [];
  }
  if (
    !Array.isArray(capabilities) ||
    !capabilities.includes(CODEBASE_CLONE_JOB_KIND) ||
    !capabilities.includes(CODEBASE_CLONE_INSPECT_JOB_KIND)
  )
    return "Update this agent to enable repository cloning";
  return null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class RepositoryCloneService {
  private readonly dispatching = new Map<
    string,
    Promise<NonNullable<Awaited<ReturnType<RepositoryCloneService["read"]>>>>
  >();
  private recovering: Promise<void> | null = null;

  constructor(private readonly agentControl: AgentControlService) {
    agentControl.registerCompletionHandler(CODEBASE_CLONE_JOB_KIND, (job) =>
      this.complete(job),
    );
    agentControl.registerConnectionHandler(() => this.recover());
  }

  async agents() {
    const prisma = await getPrismaClient();
    return (await prisma.agent.findMany({ orderBy: { name: "asc" } })).map(
      (agent) => {
        const reason = eligibility(agent);
        return {
          id: agent.id,
          name: agent.name,
          baseRepoDirectory: agent.baseRepoDirectory,
          eligible: !reason,
          reason,
        };
      },
    );
  }

  async previewDestinations(
    destinations: RepositoryCloneDestination[],
    options: { inspect?: boolean } = {},
  ): Promise<RepositoryClonePreview[]> {
    if (destinations.length > 500)
      throw new Error("At most 500 repository destinations may be selected");
    const prisma = await getPrismaClient();
    const agents = await prisma.agent.findMany({
      where: {
        id: { in: [...new Set(destinations.map((item) => item.agentId))] },
      },
    });
    const results: RepositoryClonePreview[] = [];
    const targets = new Set<string>();
    for (const destination of destinations) {
      const agent = agents.find(
        (candidate) => candidate.id === destination.agentId,
      );
      const path =
        agent?.baseRepoDirectory &&
        win32.isAbsolute(agent.baseRepoDirectory) &&
        !posix.isAbsolute(agent.baseRepoDirectory)
          ? win32
          : posix;
      const result: RepositoryClonePreview = {
        ...destination,
        repositoryId: destination.repositoryId ?? null,
        agentName: agent?.name ?? destination.agentId,
        baseDirectory: agent?.baseRepoDirectory ?? "",
        relativePath: destination.relativePath ?? "",
        destinationPath: "",
        codebaseId: null,
        status: "READY",
        error: null,
      };
      try {
        validateCloneRemote(destination.remoteUrl);
        const canonical = normalizeGitOrigin(
          destination.remoteUrl,
        ).canonicalOrigin;
        result.relativePath = validateCloneRelativePath(
          destination.relativePath || canonical.split("/").at(-1)!,
        );
        if (!agent) throw new Error("Agent was not found");
        const repository = destination.repositoryId
          ? await prisma.codebaseRepository.findUnique({
              where: { id: destination.repositoryId },
            })
          : await prisma.codebaseRepository.findUnique({
              where: { canonicalOrigin: canonical },
            });
        if (destination.repositoryId && !repository)
          throw new Error("Repository was not found");
        if (repository && repository.canonicalOrigin !== canonical)
          throw new Error("Clone URL belongs to a different repository");
        result.repositoryId = repository?.id ?? null;
        const existing = repository
          ? await prisma.codebase.findFirst({
              where: {
                agentId: agent.id,
                repositoryId: repository.id,
                availability: "AVAILABLE",
              },
              orderBy: { createdAt: "asc" },
            })
          : null;
        if (existing) {
          result.status = "REUSE";
          result.codebaseId = existing.id;
          result.destinationPath = existing.folder;
        } else {
          const reason = eligibility(agent);
          if (reason) throw new Error(reason);
          result.destinationPath = path.join(
            result.baseDirectory,
            ...result.relativePath.split("/"),
          );
          const key = `${agent.id}:${result.destinationPath.toLowerCase()}`;
          if (targets.has(key))
            throw new Error(
              "More than one selected repository uses this destination",
            );
          targets.add(key);
          const collision = await prisma.codebase.findUnique({
            where: {
              agentId_folder: {
                agentId: agent.id,
                folder: result.destinationPath,
              },
            },
          });
          if (collision && collision.repositoryId !== repository?.id)
            throw new Error(
              "A different repository is registered at this destination",
            );
          const active = await prisma.repositoryTransferItem.findFirst({
            where: {
              agentId: agent.id,
              destinationPath: result.destinationPath,
              status: { notIn: [...terminal] },
            },
          });
          if (active)
            throw new Error(
              "A repository clone is already pending at this destination",
            );
          result.codebaseId = collision?.id ?? null;
        }
      } catch (error) {
        result.status = "BLOCKED";
        result.error = problem(error);
      }
      results.push(result);
    }
    if (options.inspect !== false) {
      // Bound concurrency; one preview must not occupy every agent job slot.
      for (let offset = 0; offset < results.length; offset += 8) {
        await Promise.all(
          results.slice(offset, offset + 8).map(async (result) => {
            if (result.status === "BLOCKED") return;
            try {
              const agent = agents.find(
                (candidate) => candidate.id === result.agentId,
              )!;
              const reason = eligibility(agent);
              if (reason) throw new Error(reason);
              const inspection = await this.inspectDestination(result);
              if (inspection.status === "CONFLICT")
                throw new Error(inspection.error || "Destination is occupied");
              if (result.status === "REUSE" && inspection.status !== "REUSE")
                throw new Error(
                  "Registered checkout is missing on the agent; remove or repair its registration before importing",
                );
              // A matching unregistered checkout still needs a clone job to register its validated
              // snapshot durably. The clone handler safely reuses it without changing its files.
            } catch (error) {
              result.status = "BLOCKED";
              result.error = problem(error);
            }
          }),
        );
      }
    }
    return results;
  }

  private async inspectDestination(destination: RepositoryClonePreview) {
    const path =
      win32.isAbsolute(destination.destinationPath) &&
      !posix.isAbsolute(destination.destinationPath)
        ? win32
        : posix;
    const id = randomUUID();
    const job = await this.agentControl.createJob({
      agentId: destination.agentId,
      kind: CODEBASE_CLONE_INSPECT_JOB_KIND,
      payload: {
        operationId: id,
        itemId: id,
        codebaseId: destination.codebaseId ?? id,
        baseDirectory:
          destination.status === "REUSE"
            ? path.dirname(destination.destinationPath)
            : destination.baseDirectory,
        relativePath:
          destination.status === "REUSE"
            ? path.basename(destination.destinationPath)
            : destination.relativePath,
        remoteUrl: destination.remoteUrl,
        expectedOrigin: normalizeGitOrigin(destination.remoteUrl)
          .canonicalOrigin,
      },
      idempotencyKey: `repository-transfer:inspect:${id}`,
      timeoutSeconds: 30,
      visibility: "SYSTEM",
    });
    const events = agentEventBus.iterate(agentJobChangedTopic(job.id));
    const deadline = Date.now() + 35_000;
    try {
      while (Date.now() < deadline) {
        const current = await this.agentControl.getJob(job.id);
        if (current && terminal.has(current.status)) {
          if (current.status !== "SUCCEEDED")
            throw new Error(
              current.error || "Agent destination inspection failed",
            );
          const result = JSON.parse(current.resultJson ?? "null") as {
            destinationPath?: string;
            status?: string;
            error?: string;
          } | null;
          if (
            !result ||
            result.destinationPath !== destination.destinationPath ||
            !["MISSING", "REUSE", "CONFLICT"].includes(result.status ?? "")
          )
            throw new Error("Agent returned an invalid destination inspection");
          return result;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.min(1_000, deadline - Date.now()),
          );
          void events.next().then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await this.agentControl.cancelJob(job.id);
      throw new Error("Agent did not inspect the destination in time");
    } finally {
      await events.return?.();
      const prisma = await getPrismaClient();
      await prisma.agentJob.deleteMany({
        where: {
          id: job.id,
          status: { in: [...terminal] },
          visibility: "SYSTEM",
        },
      });
    }
  }

  async createOperation(
    transaction: Prisma.TransactionClient,
    input: {
      requestId: string;
      kind: "IMPORT" | "SYNC";
      appId?: string | null;
      result?: unknown;
      requestHash?: string;
      destinations: RepositoryClonePreview[];
    },
  ) {
    if (!input.requestId.trim())
      throw new Error("A request identifier is required");
    const requestHash =
      input.requestHash ??
      hash({
        kind: input.kind,
        appId: input.appId ?? null,
        result: input.result ?? {},
        destinations: input.destinations.map(
          ({
            repositoryKey,
            repositoryId,
            agentId,
            remoteUrl,
            relativePath,
            destinationPath,
          }) => ({
            repositoryKey,
            repositoryId,
            agentId,
            remoteUrl,
            relativePath,
            destinationPath,
          }),
        ),
      });
    const existing = await transaction.repositoryTransferOperation.findUnique({
      where: { requestId: input.requestId },
      include: operationInclude,
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new Error(
          "This request identifier was already used for different transfer selections",
        );
      return existing;
    }
    const items = [];
    const repositoryAgents = new Set<string>();
    for (const destination of input.destinations) {
      if (!destination.repositoryId)
        throw new Error(
          "A destination repository must be saved before cloning",
        );
      if (destination.status === "BLOCKED")
        throw new Error(destination.error ?? "Clone destination is blocked");
      const pair = `${destination.repositoryId}:${destination.agentId}`;
      if (repositoryAgents.has(pair))
        throw new Error(
          "A repository can only be cloned once per agent in a transfer",
        );
      repositoryAgents.add(pair);
      let codebaseId = destination.codebaseId;
      if (destination.status !== "REUSE") {
        const registered = await transaction.codebase.findUnique({
          where: {
            agentId_folder: {
              agentId: destination.agentId,
              folder: destination.destinationPath,
            },
          },
        });
        if (registered && registered.repositoryId !== destination.repositoryId)
          throw new Error("Clone destination changed; review the import again");
        const active = await transaction.repositoryTransferItem.findFirst({
          where: {
            agentId: destination.agentId,
            destinationPath: destination.destinationPath,
            status: { notIn: [...terminal] },
          },
        });
        if (active)
          throw new Error(
            "A repository clone is already pending at this destination",
          );
        codebaseId = registered?.id ?? codebaseId ?? randomUUID();
        if (!registered) {
          await transaction.codebase.create({
            data: {
              id: codebaseId,
              agentId: destination.agentId,
              repositoryId: destination.repositoryId,
              folder: destination.destinationPath,
              observedOrigin: normalizeGitOrigin(destination.remoteUrl)
                .sanitizedOrigin,
              availability: "MISSING",
              statusError: "Repository clone pending",
            },
          });
        }
      }
      items.push({
        id: randomUUID(),
        repositoryId: destination.repositoryId,
        agentId: destination.agentId,
        codebaseId,
        remoteUrl: destination.remoteUrl,
        baseDirectory: destination.baseDirectory,
        relativePath: destination.relativePath,
        destinationPath: destination.destinationPath,
        status: destination.status === "REUSE" ? "REUSED" : "PENDING",
      });
    }
    return transaction.repositoryTransferOperation.create({
      data: {
        id: randomUUID(),
        requestId: input.requestId,
        kind: input.kind,
        appId: input.appId ?? null,
        requestHash,
        resultJson: JSON.stringify(input.result ?? {}),
        items: { create: items },
      },
      include: operationInclude,
    });
  }

  /** Read persisted progress without dispatching jobs or publishing updates. */
  async read(id: string) {
    const prisma = await getPrismaClient();
    return prisma.repositoryTransferOperation.findUnique({
      where: { id },
      include: operationInclude,
    });
  }

  async get(id: string) {
    const operation = await this.read(id);
    if (!operation) return null;
    if (!operation.finishedAt) return this.dispatch(id);
    return operation;
  }

  subscribe(id: string) {
    return agentEventBus.iterate<{ repositoryTransferChanged: string }>(
      topic(id),
    );
  }

  dispatch(id: string) {
    const existing = this.dispatching.get(id);
    if (existing) return existing;
    const running = this.dispatchOperation(id).finally(() =>
      this.dispatching.delete(id),
    );
    this.dispatching.set(id, running);
    return running;
  }

  private async dispatchOperation(id: string) {
    const prisma = await getPrismaClient();
    const operation = await this.read(id);
    if (!operation) throw new Error("Repository transfer was not found");
    for (const item of operation.items) {
      if (terminal.has(item.status)) continue;
      try {
        const existingJob = item.jobId
          ? await prisma.agentJob.findUnique({ where: { id: item.jobId } })
          : await prisma.agentJob.findUnique({
              where: {
                agentId_idempotencyKey: {
                  agentId: item.agentId,
                  idempotencyKey: `repository-transfer:${item.id}`,
                },
              },
            });
        if (existingJob) {
          await prisma.repositoryTransferItem.update({
            where: { id: item.id },
            data: {
              jobId: existingJob.id,
              status: terminal.has(existingJob.status)
                ? item.status
                : existingJob.status,
              error: existingJob.error,
            },
          });
          if (terminal.has(existingJob.status))
            await this.complete(existingJob);
          continue;
        }
        if (item.jobId)
          throw new Error("Clone job was removed; retry this destination");
        const [agent, repository] = await Promise.all([
          prisma.agent.findUnique({ where: { id: item.agentId } }),
          prisma.codebaseRepository.findUnique({
            where: { id: item.repositoryId },
          }),
        ]);
        if (!agent || !repository)
          throw new Error("Clone agent or repository was removed");
        const reason = eligibility(agent);
        if (reason) throw new Error(reason);
        if (agent.baseRepoDirectory !== item.baseDirectory)
          throw new Error(
            "Agent Base repository directory changed; retry after reviewing the new destination",
          );
        const job = await this.agentControl.createJob({
          agentId: item.agentId,
          kind: CODEBASE_CLONE_JOB_KIND,
          payload: {
            operationId: id,
            itemId: item.id,
            codebaseId: item.codebaseId!,
            baseDirectory: item.baseDirectory,
            relativePath: item.relativePath,
            remoteUrl: item.remoteUrl,
            expectedOrigin: repository.canonicalOrigin,
          },
          idempotencyKey: `repository-transfer:${item.id}`,
          codebaseId: item.codebaseId,
          timeoutSeconds: 1_800,
        });
        await prisma.repositoryTransferItem.update({
          where: { id: item.id },
          data: {
            jobId: job.id,
            status: terminal.has(job.status) ? item.status : job.status,
            error: job.error,
          },
        });
        if (terminal.has(job.status)) await this.complete(job);
      } catch (error) {
        await prisma.repositoryTransferItem.update({
          where: { id: item.id },
          data: { status: "FAILED", error: problem(error) },
        });
      }
    }
    await this.finish(id);
    return (await this.read(id))!;
  }

  private async complete(
    job: Pick<
      AgentJob,
      | "id"
      | "agentId"
      | "kind"
      | "payloadJson"
      | "status"
      | "resultJson"
      | "error"
    >,
  ) {
    if (job.kind !== CODEBASE_CLONE_JOB_KIND || !terminal.has(job.status))
      return;
    const prisma = await getPrismaClient();
    const payload = JSON.parse(job.payloadJson) as {
      itemId?: string;
      operationId?: string;
    };
    const item = await prisma.repositoryTransferItem.findUnique({
      where: { id: payload.itemId ?? "" },
    });
    if (
      !item ||
      item.agentId !== job.agentId ||
      item.operationId !== payload.operationId ||
      (item.jobId && item.jobId !== job.id)
    )
      return;
    if (item.status === "SUCCEEDED" || item.status === "REUSED") return;
    let status = job.status;
    let error = job.error;
    if (job.status === "SUCCEEDED") {
      try {
        const result = JSON.parse(job.resultJson ?? "null") as {
          snapshot?: unknown;
          reused?: boolean;
        } | null;
        const snapshot = parseCodebaseSnapshot(result?.snapshot);
        const repository = await prisma.codebaseRepository.findUnique({
          where: { id: item.repositoryId },
        });
        if (
          !repository ||
          snapshot.canonicalOrigin !== repository.canonicalOrigin ||
          snapshot.folder !== item.destinationPath ||
          snapshot.linkedWorktree ||
          snapshot.availability !== "AVAILABLE"
        )
          throw new Error(
            "Clone returned a different repository or destination",
          );
        await prisma.$transaction(async (transaction) => {
          const codebase = await transaction.codebase.findUnique({
            where: { id: item.codebaseId ?? "" },
          });
          if (
            !codebase ||
            codebase.agentId !== item.agentId ||
            codebase.repositoryId !== item.repositoryId ||
            codebase.folder !== item.destinationPath
          )
            throw new Error("Pending checkout changed while cloning");
          await transaction.codebase.update({
            where: { id: codebase.id },
            data: {
              observedOrigin: snapshot.observedOrigin ?? "",
              branch: snapshot.branch,
              headSha: snapshot.headSha,
              upstream: snapshot.upstream,
              ahead: snapshot.ahead,
              behind: snapshot.behind,
              syncState: snapshot.syncState,
              availability: "AVAILABLE",
              statusError: null,
              defaultBranch: snapshot.branch,
              lastCheckedAt: new Date(snapshot.checkedAt),
              lastFetchedAt: snapshot.fetchedAt
                ? new Date(snapshot.fetchedAt)
                : null,
            },
          });
          await transaction.repositoryTransferItem.update({
            where: { id: item.id },
            data: {
              status: result?.reused ? "REUSED" : "SUCCEEDED",
              error: null,
              jobId: job.id,
            },
          });
        });
        agentEventBus.publish(CODEBASE_CHANGED_TOPIC, {
          codebaseOverviewChanged: {
            codebaseId: item.codebaseId,
            repositoryId: item.repositoryId,
            agentId: item.agentId,
          },
        });
        await this.agentControl
          .requestCodebaseReconcile([item.agentId])
          .catch((failure: unknown) => {
            console.error(
              "Could not refresh cloned repository:",
              problem(failure),
            );
          });
        await this.finish(item.operationId);
        return;
      } catch (failure) {
        status = "FAILED";
        error = problem(failure);
      }
    }
    await prisma.repositoryTransferItem.update({
      where: { id: item.id },
      data: { status, error: error ?? "Clone did not complete", jobId: job.id },
    });
    await prisma.codebase.updateMany({
      where: { id: item.codebaseId ?? "", availability: "MISSING" },
      data: { statusError: error ?? "Clone did not complete" },
    });
    await this.finish(item.operationId);
  }

  private async finish(id: string) {
    const prisma = await getPrismaClient();
    const operation = await this.read(id);
    if (!operation) return;
    const finished = operation.items.every((item) => terminal.has(item.status));
    const failures = operation.items.filter(
      (item) => !["SUCCEEDED", "REUSED"].includes(item.status),
    );
    const status = !finished
      ? "RUNNING"
      : !failures.length
        ? "SUCCEEDED"
        : failures.length === operation.items.length
          ? "FAILED"
          : "PARTIAL";
    await prisma.repositoryTransferOperation.update({
      where: { id },
      data: {
        status,
        finishedAt: finished ? (operation.finishedAt ?? new Date()) : null,
      },
    });
    agentEventBus.publish(topic(id), { repositoryTransferChanged: id });
  }

  async retry(id: string, requestId: string) {
    const prisma = await getPrismaClient();
    const previous = await this.get(id);
    if (!previous) throw new Error("Repository transfer was not found");
    const requestHash = hash({ retry: id });
    const existing = await prisma.repositoryTransferOperation.findUnique({
      where: { requestId },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new Error(
          "Retry identifier was already used for a different operation",
        );
      return this.dispatch(existing.id);
    }
    const failed = previous.items.filter(
      (item) =>
        terminal.has(item.status) &&
        !["SUCCEEDED", "REUSED"].includes(item.status),
    );
    if (!failed.length)
      throw new Error("This operation has no failed clones to retry");
    const destinations = await this.previewDestinations(
      failed.map((item) => ({
        repositoryKey: item.repositoryId,
        repositoryId: item.repositoryId,
        agentId: item.agentId,
        remoteUrl: item.remoteUrl,
        relativePath: item.relativePath,
      })),
    );
    for (const destination of destinations) {
      const original = failed.find(
        (item) =>
          item.repositoryId === destination.repositoryId &&
          item.agentId === destination.agentId,
      )!;
      if (
        destination.baseDirectory !== original.baseDirectory ||
        destination.destinationPath !== original.destinationPath
      ) {
        throw new Error(
          "Clone destination changed since the failed operation; review a new import or Sync before cloning there",
        );
      }
    }
    const operation = await prisma.$transaction((transaction) =>
      this.createOperation(transaction, {
        requestId,
        kind: previous.kind === "SYNC" ? "SYNC" : "IMPORT",
        appId: previous.appId,
        result: { retryOf: id },
        requestHash,
        destinations,
      }),
    );
    return this.dispatch(operation.id);
  }

  recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverPending().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private async recoverPending() {
    const prisma = await getPrismaClient();
    const operations = await prisma.repositoryTransferOperation.findMany({
      where: { finishedAt: null },
      select: { id: true },
    });
    for (const operation of operations) await this.dispatch(operation.id);
  }
}
