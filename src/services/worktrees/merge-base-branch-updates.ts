import { getPrismaClient } from "@/data/prisma-client";
import type { WorktreesService } from "./worktrees.service";

export type MergeBaseBranchUpdateInput = {
  worktreeIds: string[];
  destinationBaseBranch: string;
};
export type MergeBaseBranchUpdateResult = {
  worktreeId: string;
  folder: string;
  status: string;
  reason: string | null;
};
export type MergeBaseBranchUpdateOptions = {
  destinationBaseBranch: string | null;
  worktrees: {
    id: string;
    branch: string | null;
    folder: string;
    agentName: string;
    baseBranch: string;
    canUpdate: boolean;
  }[];
  selectedWorktreeIds: string[];
  results: MergeBaseBranchUpdateResult[];
};
type Source = {
  id: string;
  branch: string | null;
  baseBranchOverride: string | null;
  codebase: {
    defaultBranch: string | null;
    remoteBranchesJson?: string;
    repository: { canonicalOrigin: string };
  };
};
type Plan = {
  origin: string;
  sourceBranch: string;
  destinationBaseBranch: string;
  targets: {
    id: string;
    codebaseId: string;
    branch: string | null;
    baseBranch: string;
    folder: string;
    result?: MergeBaseBranchUpdateResult;
  }[];
};

export function readBaseBranchUpdatePlan(
  json: string | null | undefined,
): Plan | null {
  // This JSON is written only by the merge coordinator, never supplied by a client.
  return json ? (JSON.parse(json) as Plan) : null;
}

export function baseBranchUpdateResults(json: string | null | undefined) {
  return (
    readBaseBranchUpdatePlan(json)?.targets.flatMap((target) =>
      target.result ? [target.result] : [],
    ) ?? []
  );
}

export async function mergeBaseBranchUpdateOptions(
  source: Source | null,
  savedJson?: string | null,
): Promise<MergeBaseBranchUpdateOptions | null> {
  if (!source?.branch) return null;
  const previous = readBaseBranchUpdatePlan(savedJson);
  const saved =
    previous?.sourceBranch === source.branch &&
    previous.origin === source.codebase.repository.canonicalOrigin
      ? previous
      : null;
  const destinationBaseBranch =
    saved?.destinationBaseBranch ??
    source.baseBranchOverride ??
    source.codebase.defaultBranch ??
    null;
  let destinationAvailable = false;
  try {
    const branches: unknown = JSON.parse(
      source.codebase.remoteBranchesJson ?? "[]",
    );
    destinationAvailable =
      Array.isArray(branches) && branches.includes(destinationBaseBranch);
  } catch {
    /* An unreadable inventory requires a fetch before selecting updates. */
  }
  const prisma = await getPrismaClient();
  const targets = await prisma.worktree.findMany({
    where: {
      id: { not: source.id },
      missingAt: null,
      codebase: {
        repository: {
          canonicalOrigin: source.codebase.repository.canonicalOrigin,
        },
      },
      OR: [
        { baseBranchOverride: source.branch },
        {
          baseBranchOverride: null,
          codebase: { defaultBranch: source.branch },
        },
      ],
    },
    include: { codebase: { include: { agent: true } } },
    orderBy: [{ folder: "asc" }, { id: "asc" }],
  });
  return {
    destinationBaseBranch,
    worktrees: targets.map((target) => ({
      id: target.id,
      branch: target.branch,
      folder: target.folder,
      agentName: target.codebase.agent.name,
      baseBranch: target.baseBranchOverride ?? target.codebase.defaultBranch!,
      canUpdate: Boolean(
        destinationAvailable &&
        destinationBaseBranch &&
        destinationBaseBranch !== source.branch &&
        destinationBaseBranch !== target.branch,
      ),
    })),
    selectedWorktreeIds:
      saved?.targets
        .filter(
          (target) =>
            destinationAvailable &&
            destinationBaseBranch !== source.branch &&
            targets.some(
              (current) =>
                current.id === target.id &&
                current.codebaseId === target.codebaseId &&
                current.branch === target.branch &&
                current.branch !== destinationBaseBranch,
            ),
        )
        .map((target) => target.id) ?? [],
    results: baseBranchUpdateResults(savedJson),
  };
}

/** Revalidate at submission; freeze the reviewed destination and selected identities. */
export async function prepareBaseBranchUpdates(
  sourceId: string | null | undefined,
  input?: MergeBaseBranchUpdateInput | null,
  savedJson?: string | null,
): Promise<string | null> {
  if (!input?.worktreeIds.length) return null;
  const prisma = await getPrismaClient();
  const source = sourceId
    ? await prisma.worktree.findFirst({
        where: { id: sourceId, missingAt: null },
        include: { codebase: { include: { repository: true } } },
      })
    : null;
  if (!source?.branch)
    throw new Error("A matching source worktree is required for base updates");
  const options = await mergeBaseBranchUpdateOptions(source, savedJson);
  if (
    !options?.destinationBaseBranch ||
    options.destinationBaseBranch !== input.destinationBaseBranch
  )
    throw new Error(
      "The destination base branch changed; refresh merge options and try again",
    );
  const ids = [...new Set(input.worktreeIds)];
  if (
    ids.some(
      (id) =>
        !options.worktrees.some(
          (target) => target.id === id && target.canUpdate,
        ),
    )
  )
    throw new Error(
      "A selected worktree no longer targets this branch; refresh merge options and try again",
    );
  const targets = await prisma.worktree.findMany({
    where: { id: { in: ids } },
    include: { codebase: { include: { repository: true } } },
  });
  // Take and validate the snapshot from the same read, including concurrent edits.
  if (
    targets.length !== ids.length ||
    targets.some(
      (target) =>
        target.missingAt ||
        target.codebase.repository.canonicalOrigin !==
          source.codebase.repository.canonicalOrigin ||
        (target.baseBranchOverride ?? target.codebase.defaultBranch) !==
          source.branch ||
        target.branch === input.destinationBaseBranch,
    )
  )
    throw new Error(
      "A selected worktree changed; refresh merge options and try again",
    );
  const plan: Plan = {
    origin: source.codebase.repository.canonicalOrigin,
    sourceBranch: source.branch,
    destinationBaseBranch: input.destinationBaseBranch,
    targets: targets.map((target) => ({
      id: target.id,
      codebaseId: target.codebaseId,
      branch: target.branch,
      baseBranch: source.branch!,
      folder: target.folder,
    })),
  };
  return JSON.stringify(plan);
}

/** Updates and their completion markers share one transaction, so retries cannot overwrite later edits. */
export async function completeBaseBranchUpdates(
  record: { provider: "GITHUB" | "GITLAB"; id: string },
  confirmed: { origin: string; branch: string },
  worktrees: WorktreesService,
) {
  const prisma = await getPrismaClient();
  const changed = await prisma.$transaction(async (tx) => {
    const row =
      record.provider === "GITHUB"
        ? await tx.worktreeAutoMerge.findUnique({
            where: { worktreeId: record.id },
          })
        : await tx.gitLabMergeOperation.findUnique({
            where: { id: record.id },
          });
    const plan = readBaseBranchUpdatePlan(row?.baseBranchUpdatesJson);
    if (!plan) return [];
    if (
      plan.origin.toLowerCase() !== confirmed.origin.toLowerCase() ||
      plan.sourceBranch !== confirmed.branch
    )
      throw new Error(
        "The merged source does not match the reviewed base updates",
      );
    const changed: { id: string; codebaseId: string }[] = [];
    for (const target of plan.targets) {
      if (target.result) continue;
      const current = await tx.worktree.findUnique({
        where: { id: target.id },
        include: { codebase: { include: { repository: true } } },
      });
      const base = current
        ? (current.baseBranchOverride ?? current.codebase.defaultBranch)
        : null;
      const identityMatches =
        current &&
        !current.missingAt &&
        current.codebaseId === target.codebaseId &&
        current.branch === target.branch &&
        current.codebase.repository.canonicalOrigin === plan.origin;
      let status = "SKIPPED";
      let reason: string | null =
        "Worktree was removed or its repository, branch, or base changed";
      if (identityMatches && base === plan.destinationBaseBranch) {
        status = "ALREADY_UPDATED";
        reason = null;
      } else if (
        identityMatches &&
        base === target.baseBranch &&
        current.branch !== plan.destinationBaseBranch
      ) {
        await tx.worktree.update({
          where: { id: target.id },
          data: { baseBranchOverride: plan.destinationBaseBranch },
        });
        changed.push({ id: target.id, codebaseId: target.codebaseId });
        status = "UPDATED";
        reason = null;
      }
      target.result = {
        worktreeId: target.id,
        folder: target.folder,
        status,
        reason,
      };
    }
    const data = { baseBranchUpdatesJson: JSON.stringify(plan) };
    if (record.provider === "GITHUB")
      await tx.worktreeAutoMerge.update({
        where: { worktreeId: record.id },
        data,
      });
    else
      await tx.gitLabMergeOperation.update({ where: { id: record.id }, data });
    return changed;
  });
  await Promise.all(
    changed.map((target) =>
      worktrees.refreshBaseBranchWatch(target.id, target.codebaseId),
    ),
  );
}
