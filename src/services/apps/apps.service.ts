import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import { agentEventBus } from "@/services/agent-control";

export const APPS_CHANGED_TOPIC = "apps.changed";

type AppInput = {
  name: string;
  description?: string | null;
  agentIds?: string[] | null;
  repositoryIds: string[];
};

type UpdateAppInput = AppInput & { id: string };

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateInput(input: AppInput) {
  const name = input.name.trim();
  const description = input.description?.trim() ?? "";
  const agentIds = [...new Set(input.agentIds ?? [])];
  const repositoryIds = [...new Set(input.repositoryIds)];

  if (!name) throw new Error("App name is required");
  if (name.length > 120) {
    throw new Error("App name must be 120 characters or fewer");
  }
  if (description.length > 2_000) {
    throw new Error("App description must be 2,000 characters or fewer");
  }
  if (!repositoryIds.length) {
    throw new Error("Select at least one repository");
  }

  return {
    name,
    normalizedName: normalizedName(name),
    description,
    agentIds,
    repositoryIds,
  };
}

const appInclude = {
  repositories: {
    include: {
      repository: {
        include: {
          codebases: {
            include: { agent: true },
            orderBy: [{ folder: "asc" as const }, { id: "asc" as const }],
          },
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.AppInclude;

type AppRecord = Prisma.AppGetPayload<{ include: typeof appInclude }>;

export class AppsService {
  private publish(id: string | null): void {
    agentEventBus.publish(APPS_CHANGED_TOPIC, { appsChanged: { id } });
  }

  subscribe() {
    return agentEventBus.iterate<{ appsChanged: { id: string | null } }>(
      APPS_CHANGED_TOPIC,
    );
  }

  async list() {
    const prisma = await getPrismaClient();
    const apps = await prisma.app.findMany({
      include: appInclude,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return Promise.all(apps.map((app) => this.withCounts(app)));
  }

  async get(id: string) {
    const prisma = await getPrismaClient();
    const app = await prisma.app.findUnique({
      where: { id },
      include: appInclude,
    });
    return app ? this.withCounts(app) : null;
  }

  async create(input: AppInput) {
    const value = validateInput(input);
    const prisma = await getPrismaClient();
    await this.assertRepositories(value.repositoryIds);
    await this.assertUniqueName(value.normalizedName);

    const app = await prisma.app.create({
      data: {
        id: randomUUID(),
        name: value.name,
        normalizedName: value.normalizedName,
        description: value.description,
        agentIdsJson: JSON.stringify(value.agentIds),
        repositories: {
          create: value.repositoryIds.map((repositoryId) => ({
            repositoryId,
          })),
        },
      },
      include: appInclude,
    });
    this.publish(app.id);
    return this.withCounts(app);
  }

  async update(input: UpdateAppInput) {
    const value = validateInput(input);
    const prisma = await getPrismaClient();
    const existing = await prisma.app.findUnique({ where: { id: input.id } });
    if (!existing) throw new Error("App not found");

    await this.assertRepositories(value.repositoryIds);
    await this.assertUniqueName(value.normalizedName, input.id);

    const app = await prisma.$transaction(async (transaction) => {
      await transaction.appRepository.deleteMany({
        where: { appId: input.id },
      });
      return transaction.app.update({
        where: { id: input.id },
        data: {
          name: value.name,
          normalizedName: value.normalizedName,
          description: value.description,
          agentIdsJson: JSON.stringify(value.agentIds),
          repositories: {
            create: value.repositoryIds.map((repositoryId) => ({
              repositoryId,
            })),
          },
        },
        include: appInclude,
      });
    });
    this.publish(app.id);
    return this.withCounts(app);
  }

  async delete(id: string) {
    const prisma = await getPrismaClient();
    const removed = await prisma.app.deleteMany({ where: { id } });
    if (!removed.count) throw new Error("App not found");
    this.publish(id);
    return { id };
  }

  private async assertRepositories(repositoryIds: string[]): Promise<void> {
    const prisma = await getPrismaClient();
    const count = await prisma.codebaseRepository.count({
      where: { id: { in: repositoryIds } },
    });
    if (count !== repositoryIds.length) {
      throw new Error("One or more repositories could not be found");
    }
  }

  private async assertUniqueName(
    value: string,
    excludingId?: string,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const duplicate = await prisma.app.findFirst({
      where: {
        normalizedName: value,
        ...(excludingId ? { id: { not: excludingId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) throw new Error("App names must be unique");
  }

  private async withCounts(app: AppRecord) {
    const prisma = await getPrismaClient();
    const repositoryIds = app.repositories.map((item) => item.repositoryId);
    const repositoryScope = { in: repositoryIds };
    const [codebases, worktrees, dirtyWorktrees, plans, sessions, builds] =
      await Promise.all([
        prisma.codebase.count({
          where: { repositoryId: repositoryScope },
        }),
        prisma.worktree.count({
          where: {
            missingAt: null,
            codebase: { repositoryId: repositoryScope },
          },
        }),
        prisma.worktree.count({
          where: {
            missingAt: null,
            codebase: { repositoryId: repositoryScope },
            OR: [{ hasStagedChanges: true }, { hasUnstagedChanges: true }],
          },
        }),
        prisma.agentRun.count({
          where: {
            kind: "PLAN",
            archivedAt: null,
            repositoryId: repositoryScope,
          },
        }),
        prisma.agentRun.count({
          where: {
            kind: "SESSION",
            archivedAt: null,
            repositoryId: repositoryScope,
          },
        }),
        prisma.build.count({
          where: { repositoryId: repositoryScope },
        }),
      ]);

    const { repositories, agentIdsJson, ...details } = app;
    return {
      ...details,
      agentIds: this.stringArray(agentIdsJson),
      repositories: repositories.map((item) => item.repository),
      counts: {
        repositories: repositoryIds.length,
        codebases,
        worktrees,
        dirtyWorktrees,
        plans,
        sessions,
        builds,
      },
    };
  }

  private stringArray(value: string): string[] {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
}
