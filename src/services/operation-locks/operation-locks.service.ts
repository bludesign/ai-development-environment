import { randomUUID } from "node:crypto";
import {
  normalizeOperationOrigin,
  normalizeOperationResources,
  operationDescriptorsConflict,
  sourceBranchResource,
  type OperationDescriptor,
  type OperationResource,
} from "@ai-development-environment/agent-contract/operation-resources";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import { worktreeOperationResource } from "./job-resources";

type Transaction = Prisma.TransactionClient;
const MERGE_PREPARATION_RECOVERY_MS = 120_000;
export type MergeRecoveryContext = {
  provider: string;
  owner?: string;
  name?: string;
  number?: number;
  projectId?: string;
  iid?: number;
};
export type MergeReservation = { markSubmitted: () => Promise<void> };
export class ResourceBusyError extends Error {
  readonly code = "RESOURCE_BUSY";
  readonly extensions: { code: string; holderId?: string };
  constructor(
    message = "Another operation holds the required worktree or resource",
    holderId?: string,
  ) {
    super(message);
    this.name = "ResourceBusyError";
    this.extensions = { code: this.code, ...(holderId ? { holderId } : {}) };
  }
}

type StoredResource = {
  kind: string;
  key: string;
  mode: string;
  agentId: string | null;
  codebaseId: string | null;
  path: string | null;
};
export function storedDescriptor(
  resources: StoredResource[],
): OperationDescriptor {
  return {
    version: 1,
    resources: resources.map((resource) => ({
      kind: resource.kind as OperationResource["kind"],
      key: resource.key,
      mode: resource.mode as OperationResource["mode"],
      ...(resource.agentId ? { agentId: resource.agentId } : {}),
      ...(resource.codebaseId ? { codebaseId: resource.codebaseId } : {}),
      ...(resource.path ? { path: resource.path } : {}),
    })),
  };
}

export async function requestOperation(
  transaction: Transaction,
  ownerKind: string,
  ownerId: string,
  descriptor: OperationDescriptor,
) {
  const resources = normalizeOperationResources(descriptor.resources);
  return transaction.operationHolder.upsert({
    where: { ownerKind_ownerId: { ownerKind, ownerId } },
    create: {
      id: `${ownerKind}:${ownerId}`,
      ownerKind,
      ownerId,
      resources: {
        create: resources.map((resource) => ({
          id: randomUUID(),
          ...resource,
        })),
      },
    },
    update: {},
    include: { resources: true },
  });
}

/** Short transactional fences cover hierarchical barriers and cross-clone branches. */
export async function admitOperation(
  transaction: Transaction,
  ownerKind: string,
  ownerId: string,
  descriptor: OperationDescriptor,
  executionToken: string,
  parentId?: string,
) {
  const fences = new Set<string>();
  for (const resource of descriptor.resources) {
    fences.add(resource.key);
    if (resource.agentId) fences.add(`agent:${resource.agentId}`);
    if (resource.agentId && resource.codebaseId)
      fences.add(`${resource.agentId}:codebase:${resource.codebaseId}`);
  }
  for (const key of [...fences].sort())
    await transaction.operationAdmissionLane.upsert({
      where: { key },
      create: { key },
      update: { updatedAt: new Date() },
    });
  const holder = await requestOperation(
    transaction,
    ownerKind,
    ownerId,
    descriptor,
  );
  if (holder.state === "HELD" || holder.state === "RELEASING") {
    if (holder.executionToken !== executionToken)
      throw new ResourceBusyError(
        "This execution is already owned by another agent session",
        holder.id,
      );
    return holder;
  }
  if (holder.state === "RELEASED")
    throw new Error("This operation has already finished");
  const holders = await transaction.operationHolder.findMany({
    where: {
      id: { not: holder.id },
      state: { in: ["REQUESTED", "HELD", "RELEASING"] },
    },
    include: { resources: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const parent = parentId
    ? holders.find(
        (candidate) =>
          candidate.ownerKind === "WORKTREE_MOVE" &&
          candidate.ownerId === parentId &&
          candidate.state === "HELD",
      )
    : null;
  for (const other of holders) {
    if (parent && other.id === parent.id) {
      const parentResources = storedDescriptor(parent.resources).resources;
      const sourceResources = descriptor.resources.filter(
        (resource) => resource.kind === "WORKTREE",
      );
      if (
        sourceResources.some(
          (resource) =>
            !parentResources.some(
              (allowed) =>
                allowed.kind === resource.kind && allowed.key === resource.key,
            ),
        )
      )
        throw new Error("Move child requested an undeclared worktree");
      continue;
    }
    const earlier =
      other.createdAt < holder.createdAt ||
      (other.createdAt.getTime() === holder.createdAt.getTime() &&
        other.id < holder.id);
    if (
      parent &&
      other.state === "REQUESTED" &&
      operationDescriptorsConflict(
        storedDescriptor(parent.resources),
        storedDescriptor(other.resources),
      )
    )
      continue;
    if (
      other.state === "REQUESTED" &&
      ownerKind === "AGENT_JOB" &&
      !descriptor.resources.some((resource) =>
        resource.key.includes(":build-stability:"),
      ) &&
      descriptor.resources.length > 0 &&
      descriptor.resources.every((resource) => resource.mode === "READ") &&
      holders.some(
        (active) =>
          active.state !== "REQUESTED" &&
          active.resources.some((resource) => resource.mode === "BUILD") &&
          operationDescriptorsConflict(
            storedDescriptor(active.resources),
            storedDescriptor(other.resources),
          ),
      )
    )
      continue;
    if (
      (other.state !== "REQUESTED" || earlier) &&
      operationDescriptorsConflict(
        descriptor,
        storedDescriptor(other.resources),
      )
    )
      throw new ResourceBusyError(
        `Waiting for ${other.ownerKind === "MERGE_SUBMISSION" ? "merge submission" : "another operation"} on this resource`,
        other.id,
      );
  }
  return transaction.operationHolder.update({
    where: { id: holder.id },
    data: { state: "HELD", executionToken },
    include: { resources: true },
  });
}

export async function releaseOperation(
  ownerKind: string,
  ownerId: string,
  executionToken?: string | null,
  transaction?: Transaction,
) {
  const client = transaction ?? (await getPrismaClient());
  const holder = await client.operationHolder.findUnique({
    where: { ownerKind_ownerId: { ownerKind, ownerId } },
  });
  if (!holder || holder.state === "RELEASED") return;
  if (holder.executionToken && holder.executionToken !== executionToken)
    throw new Error("Operation execution token does not match its owner");
  await client.operationHolder.update({
    where: { id: holder.id },
    data: { state: "RELEASED" },
  });
}

export async function operationBlockedReason(
  descriptor: OperationDescriptor,
): Promise<string | null> {
  const prisma = await getPrismaClient();
  const holders = await prisma.operationHolder.findMany({
    where: { state: { in: ["HELD", "RELEASING"] } },
    include: { resources: true },
  });
  for (const holder of holders)
    if (
      operationDescriptorsConflict(
        descriptor,
        storedDescriptor(holder.resources),
      )
    ) {
      const building =
        holder.ownerKind === "AGENT_JOB" &&
        holder.resources.some((resource) => resource.mode === "BUILD");
      if (holder.ownerKind === "AGENT_RUN")
        return "Waiting for an AI session to finish in this worktree";
      if (holder.ownerKind === "WORKTREE_MOVE")
        return "Waiting for a move of this worktree to finish";
      if (holder.ownerKind === "MERGE_SUBMISSION")
        return "Waiting for merge submission confirmation";
      return building
        ? "A build is active on this source worktree"
        : "Another operation holds this worktree or resource";
    }
  return null;
}

export async function jobBlockedReason(jobId: string): Promise<string | null> {
  const prisma = await getPrismaClient();
  const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "QUEUED" || !job.operationResourcesJson)
    return null;
  return operationBlockedReason(JSON.parse(job.operationResourcesJson));
}

export async function hasLocalSourceWorktrees(
  origin: string,
  branch: string,
): Promise<boolean> {
  const prisma = await getPrismaClient();
  return (
    (await prisma.worktree.count({
      where: {
        branch,
        missingAt: null,
        availability: "AVAILABLE",
        codebase: {
          repository: { canonicalOrigin: normalizeOperationOrigin(origin) },
        },
      },
    })) > 0
  );
}

async function mergeDescriptor(
  origin: string,
  branch: string,
): Promise<OperationDescriptor> {
  const prisma = await getPrismaClient();
  const worktrees = await prisma.worktree.findMany({
    where: {
      branch,
      missingAt: null,
      availability: "AVAILABLE",
      codebase: {
        repository: { canonicalOrigin: normalizeOperationOrigin(origin) },
      },
    },
    include: { codebase: true },
  });
  return {
    version: 1,
    resources: normalizeOperationResources([
      sourceBranchResource(origin, branch, "WRITE"),
      ...worktrees.map((target) =>
        worktreeOperationResource(target, target.codebase.agentId, "READ"),
      ),
    ]),
  };
}

export async function mergeReservationBlockedReason(
  origin: string,
  branch: string,
): Promise<string | null> {
  return operationBlockedReason(await mergeDescriptor(origin, branch));
}

/** Provider calls are guarded at their common mutation boundary, including tools/workflows. */
export async function withMergeReservation<T>(
  origin: string,
  branch: string,
  task: (reservation: MergeReservation) => Promise<T>,
  recovery?: MergeRecoveryContext,
): Promise<T> {
  const prisma = await getPrismaClient();
  const descriptor = await mergeDescriptor(origin, branch);
  const ownerId = randomUUID();
  const token = randomUUID();
  const preparing = JSON.stringify({
    outcome: "PREPARING",
    origin: normalizeOperationOrigin(origin),
    branch,
    mergeRecovery: recovery,
  });
  try {
    await prisma.$transaction(async (transaction) => {
      await admitOperation(
        transaction,
        "MERGE_SUBMISSION",
        ownerId,
        descriptor,
        token,
      );
      await transaction.operationHolder.update({
        where: {
          ownerKind_ownerId: { ownerKind: "MERGE_SUBMISSION", ownerId },
        },
        data: { resultJson: preparing },
      });
    });
  } catch (error) {
    await prisma.operationHolder.deleteMany({
      where: { ownerKind: "MERGE_SUBMISSION", ownerId, state: "REQUESTED" },
    });
    throw error;
  }
  let uncertain = false;
  try {
    const result = await task({
      markSubmitted: async () => {
        const marked = await prisma.operationHolder.updateMany({
          where: {
            ownerKind: "MERGE_SUBMISSION",
            ownerId,
            state: "HELD",
            executionToken: token,
            resultJson: preparing,
          },
          data: {
            resultJson: JSON.stringify({
              outcome: "SUBMITTING",
              origin: normalizeOperationOrigin(origin),
              branch,
              mergeRecovery: recovery,
            }),
          },
        });
        if (!marked.count)
          throw new ResourceBusyError(
            "Merge reservation was superseded before submission; retry the merge",
          );
      },
    });
    try {
      await prisma.operationHolder.update({
        where: {
          ownerKind_ownerId: { ownerKind: "MERGE_SUBMISSION", ownerId },
        },
        data: { resultJson: JSON.stringify({ outcome: "CONFIRMED" }) },
      });
    } catch (error) {
      console.error(
        "Merge succeeded; its reservation will be reconciled from provider state:",
        error,
      );
    }
    return result;
  } catch (error) {
    uncertain = Boolean(
      error &&
      typeof error === "object" &&
      "mergeOutcomeUnknown" in error &&
      error.mergeOutcomeUnknown,
    );
    if (uncertain)
      await prisma.operationHolder.update({
        where: {
          ownerKind_ownerId: { ownerKind: "MERGE_SUBMISSION", ownerId },
        },
        data: {
          resultJson: JSON.stringify({
            outcome: "UNKNOWN",
            origin: normalizeOperationOrigin(origin),
            branch,
            mergeRecovery:
              error && typeof error === "object" && "mergeRecovery" in error
                ? error.mergeRecovery
                : recovery,
          }),
        },
      });
    throw error;
  } finally {
    if (!uncertain) {
      try {
        await releaseOperation("MERGE_SUBMISSION", ownerId, token);
      } catch (error) {
        console.error(
          "Could not release merge reservation; recovery retains its ownership:",
          error,
        );
      }
    }
  }
}

export async function recoverMergeReservations(
  origin: string,
  branch: string,
  verifyOutcome: (context?: MergeRecoveryContext) => Promise<boolean>,
): Promise<void> {
  const prisma = await getPrismaClient();
  const holders = await prisma.operationHolder.findMany({
    where: {
      ownerKind: "MERGE_SUBMISSION",
      state: "HELD",
      resources: { some: { key: sourceBranchResource(origin, branch).key } },
    },
  });
  for (const holder of holders) {
    if (!holder.resultJson) continue;
    const result = JSON.parse(holder.resultJson) as {
      outcome: string;
      mergeRecovery?: MergeRecoveryContext;
    };
    if (result.outcome === "PREPARING") {
      // Live validation keeps its FIFO place. A stale preparation can be
      // invalidated safely because markSubmitted compares this exact record.
      if (
        Date.now() - holder.updatedAt.getTime() <
        MERGE_PREPARATION_RECOVERY_MS
      )
        continue;
      await prisma.operationHolder.updateMany({
        where: {
          id: holder.id,
          state: "HELD",
          executionToken: holder.executionToken,
          resultJson: holder.resultJson,
        },
        data: { state: "RELEASED" },
      });
    } else if (
      result.outcome === "CONFIRMED" ||
      (["UNKNOWN", "SUBMITTING"].includes(result.outcome) &&
        (await verifyOutcome(result.mergeRecovery)))
    ) {
      await releaseOperation(
        "MERGE_SUBMISSION",
        holder.ownerId,
        holder.executionToken,
      );
    }
  }
}
