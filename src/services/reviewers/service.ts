import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import {
  agentEventBus,
  CODEBASE_CHANGED_TOPIC,
  WORKTREE_CHANGED_TOPIC,
} from "@/services/agent-control";
import type {
  ReviewerDiscovery,
  ReviewerPerson,
  ReviewerProviderAdapter,
  SaveReviewerPoolsInput,
} from "./types";

type StoredPool = Prisma.RepositoryReviewerPoolGetPayload<{
  include: { members: true };
}>;

const unique = (values: string[]) => [...new Set(values)];
const transferPerson = z
  .object({
    id: z.string().min(1).max(500),
    username: z.string().max(500),
    name: z.string().max(500),
    avatarUrl: z.string().max(4000).nullable(),
    url: z.string().max(4000).nullable(),
  })
  .strict();
export const transferredReviewerPoolsSchema = z
  .array(
    z
      .object({
        key: z.string().min(1).max(2000),
        name: z.string().max(2000),
        kind: z.enum(["GENERAL", "CODEOWNERS", "APPROVAL_RULE"]),
        provider: z.enum(["GITHUB", "GITLAB"]),
        repositoryIdentity: z.string().min(1).max(2000),
        ref: z.string().max(1000),
        reviewers: z.array(transferPerson).max(1000),
      })
      .strict(),
  )
  .max(500);
export type TransferredReviewerPools = z.infer<
  typeof transferredReviewerPoolsSchema
>;
const personFromMember = (
  member: StoredPool["members"][number],
): ReviewerPerson => ({
  id: member.userId,
  username: member.username,
  name: member.name,
  avatarUrl: member.avatarUrl,
  url: member.url,
});

export function repositoryReviewerView(
  repositoryId: string,
  discovery: ReviewerDiscovery,
  saved: StoredPool[],
) {
  const remaining = new Map(saved.map((pool) => [pool.key, pool]));
  const pools = discovery.pools.map((pool) => {
    const stored = remaining.get(pool.key);
    remaining.delete(pool.key);
    const candidates = new Set(pool.candidates.map((person) => person.id));
    const selectedReviewerIds =
      stored?.members.map((member) => member.userId) ?? [];
    return {
      ...pool,
      selectedReviewerIds,
      unavailableReviewerIds: selectedReviewerIds.filter(
        (id) =>
          stored?.repositoryIdentity !== discovery.repositoryIdentity ||
          !candidates.has(id),
      ),
    };
  });
  for (const pool of remaining.values()) {
    pools.push({
      key: pool.key,
      name: pool.name,
      kind: pool.kind as "GENERAL" | "CODEOWNERS" | "APPROVAL_RULE",
      candidates: [],
      selectedReviewerIds: pool.members.map((member) => member.userId),
      unavailableReviewerIds: pool.members.map((member) => member.userId),
    });
  }
  return { repositoryId, ...discovery, pools };
}

export function reviewerAssignmentView(
  worktreeId: string,
  discovery: ReviewerDiscovery,
  saved: StoredPool[],
) {
  const request = discovery.request;
  if (!request) throw new Error("Pull or merge request was not found");
  const currentReviewerIds = unique(
    request.currentReviewers.map((person) => person.id),
  );
  const approvedReviewerIds = unique(
    request.approvedReviewers.map((person) => person.id),
  );
  const current = new Set(currentReviewerIds);
  const approved = new Set(approvedReviewerIds);
  const livePoolMembers = new Map(
    discovery.pools.map((pool) => [
      pool.key,
      new Set(pool.candidates.map((person) => person.id)),
    ]),
  );
  const preferences = new Map(
    saved
      .filter(
        (pool) => pool.repositoryIdentity === discovery.repositoryIdentity,
      )
      .map((pool) => [
        pool.key,
        new Set(
          pool.members
            .map((member) => member.userId)
            .filter((id) => livePoolMembers.get(pool.key)?.has(id)),
        ),
      ]),
  );
  const poolPeople = discovery.pools.flatMap((pool) => pool.candidates);
  const people = new Map(
    [
      ...poolPeople,
      ...request.currentReviewers,
      ...request.approvedReviewers,
    ].map((person) => [person.id, person]),
  );
  let discoveredRequirements = discovery.requirements;
  if (!discoveredRequirements.length) {
    const general = discovery.pools.find((pool) => pool.kind === "GENERAL");
    if (general) {
      discoveredRequirements = [
        {
          id: "general-reviewers",
          name: "General reviewers",
          poolKeys: [general.key],
          eligibleReviewerIds: general.candidates.map((person) => person.id),
          approvedReviewerIds,
          requiredApprovals: 1,
        },
      ];
    }
  }
  const requirements = discoveredRequirements.map((rule) => {
    const eligible = new Set(
      rule.eligibleReviewerIds.filter((id) => id !== request.authorId),
    );
    const preferred = new Set(
      rule.poolKeys.flatMap((key) => [...(preferences.get(key) ?? [])]),
    );
    return {
      ...rule,
      eligibleReviewerIds: [...eligible],
      candidateReviewerIds: [...preferred].filter(
        (id) =>
          eligible.has(id) &&
          people.has(id) &&
          !current.has(id) &&
          !approved.has(id),
      ),
      approvedReviewerIds: unique(
        rule.approvedReviewerIds.filter((id) => eligible.has(id)),
      ),
      requestedReviewerIds: currentReviewerIds.filter((id) => eligible.has(id)),
    };
  });
  const referencedPeople = new Set([
    ...currentReviewerIds,
    ...approvedReviewerIds,
    ...requirements.flatMap((rule) => [
      ...rule.candidateReviewerIds,
      ...rule.approvedReviewerIds,
      ...rule.requestedReviewerIds,
    ]),
  ]);
  return {
    worktreeId,
    requestId: request.id,
    requestUrl: request.url,
    provider: discovery.provider,
    requestOpen: request.open,
    authorId: request.authorId,
    reviewers: [...people.values()].filter((person) =>
      referencedPeople.has(person.id),
    ),
    requirements,
    currentReviewerIds,
    approvedReviewerIds,
    selectedReviewerIds: [] as string[],
    issues: [
      ...discovery.issues,
      ...(!discovery.discoveryComplete && !discovery.requirements.length
        ? [
            "General reviewer selection is available, but provider approval requirements could not be verified.",
          ]
        : []),
    ],
    discoveryComplete: discovery.discoveryComplete,
  };
}

export type ReviewerAssignment = ReturnType<typeof reviewerAssignmentView>;

export function randomReviewerPreview(
  assignment: ReviewerAssignment,
  selectedReviewerIds: string[] = [],
  random = Math.random,
): ReviewerAssignment {
  const candidates = unique(
    assignment.requirements.flatMap((rule) => rule.candidateReviewerIds),
  );
  const allowed = new Set(candidates);
  const selected = new Set(selectedReviewerIds.filter((id) => allowed.has(id)));
  const covered = (rule: ReviewerAssignment["requirements"][number]) =>
    new Set([
      ...rule.approvedReviewerIds,
      ...rule.requestedReviewerIds,
      ...[...selected].filter((id) => rule.eligibleReviewerIds.includes(id)),
    ]).size;
  for (let index = candidates.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [candidates[index], candidates[other]] = [
      candidates[other],
      candidates[index],
    ];
  }
  for (const id of candidates) {
    if (
      assignment.requirements.some(
        (rule) =>
          covered(rule) < rule.requiredApprovals &&
          rule.candidateReviewerIds.includes(id),
      )
    )
      selected.add(id);
  }
  const shortages = assignment.requirements.flatMap((rule) => {
    const missing = Math.max(0, rule.requiredApprovals - covered(rule));
    return missing
      ? [
          `${rule.name}: ${missing} more eligible reviewer${missing === 1 ? "" : "s"} needed. Configure additional reviewers in repository settings.`,
        ]
      : [];
  });
  return {
    ...assignment,
    selectedReviewerIds: [...selected],
    issues: [...assignment.issues, ...shortages],
  };
}

export class ReviewersService {
  private readonly assignments = new Map<string, Promise<unknown>>();

  constructor(
    private readonly providers: ReviewerProviderAdapter,
    private readonly refreshWorktree?: (id: string) => Promise<unknown>,
  ) {}

  private async repository(id: string) {
    const prisma = await getPrismaClient();
    const repository = await prisma.codebaseRepository.findUnique({
      where: { id },
    });
    if (!repository) throw new Error("Repository not found");
    return repository;
  }

  private async saved(repositoryId: string) {
    const prisma = await getPrismaClient();
    return prisma.repositoryReviewerPool.findMany({
      where: { repositoryId },
      include: { members: true },
      orderBy: { key: "asc" },
    });
  }

  async repositoryCodeReviewers(
    repositoryId: string,
    ref?: string | null,
    refresh = false,
  ) {
    const repository = await this.repository(repositoryId);
    const [discovery, saved] = await Promise.all([
      this.providers.discover(repository, ref ?? undefined, undefined, refresh),
      this.saved(repositoryId),
    ]);
    return repositoryReviewerView(repositoryId, discovery, saved);
  }

  async saveRepositoryCodeReviewers(input: SaveReviewerPoolsInput) {
    if (input.pools.length > 500)
      throw new Error("At most 500 reviewer pools can be saved at once");
    const repository = await this.repository(input.repositoryId);
    const [discovery, saved] = await Promise.all([
      this.providers.discover(
        repository,
        input.ref ?? undefined,
        undefined,
        true,
      ),
      this.saved(repository.id),
    ]);
    const normalized = this.validatePools(input.pools, discovery, saved);
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (tx) => {
      await this.writePools(tx, repository.id, discovery, normalized);
      await this.updateConfiguredFlag(tx, repository.id);
    });
    this.publish(repository.id);
    return this.repositoryCodeReviewers(repository.id, input.ref);
  }

  private validatePools(
    inputs: SaveReviewerPoolsInput["pools"],
    discovery: ReviewerDiscovery,
    saved: StoredPool[] = [],
  ) {
    const pools = new Map(discovery.pools.map((pool) => [pool.key, pool]));
    const old = new Map(saved.map((pool) => [pool.key, pool]));
    const seen = new Set<string>();
    return inputs.map((input) => {
      if (!input.key || input.key.length > 2000 || seen.has(input.key))
        throw new Error("Reviewer pool keys must be unique");
      seen.add(input.key);
      if (input.reviewerIds.length > 1000)
        throw new Error("At most 1,000 reviewers can be selected per pool");
      const pool = pools.get(input.key);
      const previous = old.get(input.key);
      if (!pool && !previous && input.reviewerIds.length)
        throw new Error(
          "Reviewer group is no longer available; refresh repository settings",
        );
      const people = new Map(
        pool?.candidates.map((person) => [person.id, person]) ?? [],
      );
      if (previous?.repositoryIdentity === discovery.repositoryIdentity) {
        for (const member of previous.members) {
          if (!people.has(member.userId))
            people.set(member.userId, personFromMember(member));
        }
      }
      const members = unique(input.reviewerIds).map((id) => {
        const person = people.get(id);
        if (!person)
          throw new Error(
            "A selected reviewer is no longer eligible; refresh repository settings",
          );
        return person;
      });
      return {
        key: input.key,
        name: pool?.name ?? previous?.name ?? input.key,
        kind: pool?.kind ?? previous?.kind ?? "GENERAL",
        discoveryRef: pool
          ? discovery.ref
          : (previous?.discoveryRef ?? discovery.ref),
        members,
      };
    });
  }

  private async writePools(
    tx: Prisma.TransactionClient,
    repositoryId: string,
    discovery: Pick<ReviewerDiscovery, "provider" | "repositoryIdentity">,
    pools: Array<{
      key: string;
      name: string;
      kind: string;
      discoveryRef: string;
      members: ReviewerPerson[];
    }>,
  ) {
    for (const pool of pools) {
      if (!pool.members.length) {
        await tx.repositoryReviewerPool.deleteMany({
          where: { repositoryId, key: pool.key },
        });
        continue;
      }
      const record = await tx.repositoryReviewerPool.upsert({
        where: { repositoryId_key: { repositoryId, key: pool.key } },
        create: {
          id: randomUUID(),
          repositoryId,
          key: pool.key,
          name: pool.name,
          kind: pool.kind,
          provider: discovery.provider,
          repositoryIdentity: discovery.repositoryIdentity,
          discoveryRef: pool.discoveryRef,
        },
        update: {
          name: pool.name,
          kind: pool.kind,
          provider: discovery.provider,
          repositoryIdentity: discovery.repositoryIdentity,
          discoveryRef: pool.discoveryRef,
        },
      });
      await tx.repositoryReviewerMember.deleteMany({
        where: { poolId: record.id },
      });
      await tx.repositoryReviewerMember.createMany({
        data: pool.members.map(({ id, ...person }) => ({
          poolId: record.id,
          userId: id,
          ...person,
        })),
      });
    }
  }

  private async updateConfiguredFlag(
    tx: Prisma.TransactionClient,
    repositoryId: string,
  ) {
    const count = await tx.repositoryReviewerMember.count({
      where: { pool: { repositoryId } },
    });
    await tx.codebaseRepository.update({
      where: { id: repositoryId },
      data: { hasConfiguredCodeReviewers: count > 0, updatedAt: new Date() },
    });
  }

  async exportPools(repositoryId: string): Promise<TransferredReviewerPools> {
    return (await this.saved(repositoryId)).map((pool) => ({
      key: pool.key,
      name: pool.name,
      kind: pool.kind as "GENERAL" | "CODEOWNERS" | "APPROVAL_RULE",
      provider: pool.provider as "GITHUB" | "GITLAB",
      repositoryIdentity: pool.repositoryIdentity,
      ref: pool.discoveryRef,
      reviewers: pool.members.map(personFromMember),
    }));
  }

  async validateTransferredPools(
    repository: { id: string; canonicalOrigin: string },
    value: unknown,
  ): Promise<TransferredReviewerPools> {
    const pools = transferredReviewerPoolsSchema.parse(value);
    const discoveries = new Map<string, ReviewerDiscovery>();
    const result: TransferredReviewerPools = [];
    for (const pool of pools) {
      let discovery = discoveries.get(pool.ref);
      if (!discovery) {
        discovery = await this.providers.discover(
          repository,
          pool.ref || undefined,
          undefined,
          true,
        );
        discoveries.set(pool.ref, discovery);
      }
      const instance = (identity: string) =>
        identity.slice(0, identity.lastIndexOf(":"));
      if (
        pool.provider !== discovery.provider ||
        instance(pool.repositoryIdentity) !==
          instance(discovery.repositoryIdentity) ||
        !pool.key.startsWith(`${pool.repositoryIdentity}:`)
      ) {
        throw new Error(
          "Reviewer pools belong to a different provider instance. Deselect Code reviewers in this import and configure reviewers in the destination repository.",
        );
      }
      const destinationKey = `${discovery.repositoryIdentity}${pool.key.slice(pool.repositoryIdentity.length)}`;
      const target = discovery.pools.find(
        (candidate) => candidate.key === destinationKey,
      );
      const eligible = new Map(
        target?.candidates.map((person) => [person.id, person]) ?? [],
      );
      if (
        !target ||
        pool.reviewers.some((person) => !eligible.has(person.id))
      ) {
        throw new Error(
          `Reviewer group ${pool.name} or one of its people cannot be resolved at the destination. Deselect Code reviewers in this import and configure reviewers in the destination repository.`,
        );
      }
      result.push({
        key: destinationKey,
        name: target.name,
        kind: target.kind,
        provider: discovery.provider,
        repositoryIdentity: discovery.repositoryIdentity,
        ref: discovery.ref,
        reviewers: pool.reviewers.map((person) => eligible.get(person.id)!),
      });
    }
    if (new Set(result.map((pool) => pool.key)).size !== result.length)
      throw new Error("Imported reviewer pools contain duplicate groups");
    return result;
  }

  async applyTransferredPools(
    tx: Prisma.TransactionClient,
    repositoryId: string,
    pools: TransferredReviewerPools,
  ) {
    await tx.repositoryReviewerPool.deleteMany({ where: { repositoryId } });
    for (const pool of pools) {
      await this.writePools(
        tx,
        repositoryId,
        {
          provider: pool.provider,
          repositoryIdentity: pool.repositoryIdentity,
        },
        [{ ...pool, discoveryRef: pool.ref, members: pool.reviewers }],
      );
    }
    await this.updateConfiguredFlag(tx, repositoryId);
  }

  private async context(worktreeId: string) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      include: {
        codebase: { include: { repository: true } },
        pullRequest: true,
        gitLabMergeRequest: true,
      },
    });
    if (!worktree) throw new Error("Worktree not found");
    const repository = worktree.codebase.repository;
    if (!repository.hasConfiguredCodeReviewers)
      throw new Error("Configure code reviewers in repository settings first");
    const mr = worktree.gitLabMergeRequest;
    const pr = worktree.pullRequest;
    const sourceBranch = mr?.sourceBranch ?? pr?.headRefName;
    if (
      !worktree.branch ||
      sourceBranch !== worktree.branch ||
      worktree.pullRequestLookupBranch !== worktree.branch ||
      worktree.pullRequestLookupOrigin?.toLowerCase() !==
        repository.canonicalOrigin.toLowerCase()
    ) {
      throw new Error(
        "The worktree branch or repository has changed; refresh the linked pull or merge request before assigning reviewers",
      );
    }
    const locator = mr
      ? { id: mr.gitlabId, number: mr.iid, projectId: mr.projectId }
      : pr
        ? { id: pr.githubId, number: pr.number }
        : null;
    if (!locator)
      throw new Error("Worktree does not have an open pull or merge request");
    return { worktree, repository, locator };
  }

  private async live(worktreeId: string) {
    const context = await this.context(worktreeId);
    const discovery = await this.providers.discover(
      context.repository,
      undefined,
      context.locator,
      true,
    );
    const current = await this.context(worktreeId);
    if (
      current.locator.id !== context.locator.id ||
      current.repository.id !== context.repository.id ||
      current.worktree.branch !== context.worktree.branch
    ) {
      throw new Error(
        "The linked pull or merge request has changed; reload reviewer options before assigning",
      );
    }
    const saved = await this.saved(current.repository.id);
    const assignment = reviewerAssignmentView(worktreeId, discovery, saved);
    if (!assignment.requestOpen)
      throw new Error(
        "Pull or merge request is no longer open; refresh this worktree",
      );
    return { ...current, discovery, assignment };
  }

  async worktreeReviewerAssignment(worktreeId: string) {
    return (await this.live(worktreeId)).assignment;
  }

  async previewRandomWorktreeReviewers(
    worktreeId: string,
    requestId: string,
    selectedReviewerIds?: string[] | null,
  ) {
    const { assignment } = await this.live(worktreeId);
    this.requireRequest(assignment, requestId);
    return randomReviewerPreview(assignment, selectedReviewerIds ?? []);
  }

  private requireRequest(assignment: ReviewerAssignment, requestId: string) {
    if (assignment.requestId !== requestId)
      throw new Error(
        "The pull or merge request has changed; reload reviewer options before assigning",
      );
  }

  async assignWorktreeReviewers(input: {
    worktreeId: string;
    requestId: string;
    reviewerIds: string[];
  }) {
    // Serialize this control plane's additive writes for the same worktree.
    const previous =
      this.assignments.get(input.worktreeId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const { repository, locator, assignment } = await this.live(
          input.worktreeId,
        );
        this.requireRequest(assignment, input.requestId);
        const ids = unique(input.reviewerIds);
        if (!ids.length || ids.length > 1000)
          throw new Error("Select between 1 and 1,000 reviewers");
        const candidates = new Set(
          assignment.requirements.flatMap((rule) => rule.candidateReviewerIds),
        );
        const existing = new Set(assignment.currentReviewerIds);
        if (ids.some((id) => !candidates.has(id) && !existing.has(id)))
          throw new Error(
            "A selected reviewer is no longer eligible; reload reviewer options before assigning",
          );
        const additions = ids.filter((id) => !existing.has(id));
        if (additions.length) {
          await this.providers.assign(
            repository,
            locator,
            assignment.reviewers.filter((person) =>
              additions.includes(person.id),
            ),
          );
        }
        // A successful provider write must not be reported as failed solely because overview hydration failed.
        await this.refreshWorktree?.(input.worktreeId).catch(() => undefined);
        this.publish(repository.id, input.worktreeId);
        try {
          return await this.worktreeReviewerAssignment(input.worktreeId);
        } catch {
          const currentReviewerIds = unique([
            ...assignment.currentReviewerIds,
            ...additions,
          ]);
          return {
            ...assignment,
            currentReviewerIds,
            requirements: assignment.requirements.map((rule) => ({
              ...rule,
              candidateReviewerIds: rule.candidateReviewerIds.filter(
                (id) => !additions.includes(id),
              ),
              requestedReviewerIds: currentReviewerIds.filter((id) =>
                rule.eligibleReviewerIds.includes(id),
              ),
            })),
            issues: [
              ...assignment.issues,
              "Review requests were sent. Reload reviewer options to refresh provider status.",
            ],
          };
        }
      });
    this.assignments.set(input.worktreeId, task);
    try {
      return await task;
    } finally {
      if (this.assignments.get(input.worktreeId) === task)
        this.assignments.delete(input.worktreeId);
    }
  }

  private publish(repositoryId: string, worktreeId: string | null = null) {
    agentEventBus.publish(CODEBASE_CHANGED_TOPIC, {
      codebaseOverviewChanged: { repositoryId, codebaseId: null },
    });
    agentEventBus.publish(WORKTREE_CHANGED_TOPIC, {
      worktreeOverviewChanged: { worktreeId, codebaseId: null },
    });
  }
}
