// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { PrismaClient } from "@/generated/prisma/client";
import { createModelCostResolvers } from "@/graphql/resolvers/model-costs";
import {
  DEFAULT_MODEL_COST_URL,
  ModelCostsService,
} from "@/services/model-costs";

import { RunsService } from "./runs.service";

describe("run list catalog costs", () => {
  let directory: string;
  let prisma: InstanceType<typeof PrismaClient>;
  const runs = new RunsService();
  const catalogCost = createModelCostResolvers(new ModelCostsService()).AgentRun
    .catalogCost;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "aide-run-catalog-cost-"));
    const databasePath = join(directory, "test.db");
    const database = new Database(databasePath);
    const migrationsRoot = resolve(process.cwd(), "prisma/migrations");
    try {
      database.transaction(() => {
        for (const migration of readdirSync(migrationsRoot).toSorted()) {
          const path = join(migrationsRoot, migration, "migration.sql");
          if (existsSync(path)) database.exec(readFileSync(path, "utf8"));
        }
      })();
    } finally {
      database.close();
    }
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: databasePath }),
    });
    mocks.getPrismaClient.mockResolvedValue(prisma);
    await prisma.modelCostSettings.create({
      data: {
        id: "default",
        fetchedAt: new Date(),
        sourceUrl: DEFAULT_MODEL_COST_URL,
        entryCount: 2,
      },
    });
    await prisma.modelCostEntry.createMany({
      data: [
        {
          model: "model-a",
          inputCostPerToken: 0.01,
          outputCostPerToken: 0.02,
          cacheReadCostPerToken: 0.001,
          cacheWriteCostPerToken: 0.015,
        },
        {
          model: "model-b",
          inputCostPerToken: 0.02,
          outputCostPerToken: 0.04,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test.each([
    ["PLAN", "IMPORTED"],
    ["PLAN", "MANAGED"],
    ["SESSION", "IMPORTED"],
    ["SESSION", "MANAGED"],
  ])("prices %s %s rows the same as their details", async (kind, origin) => {
    const id = `${kind}-${origin}`;
    await prisma.agentRun.create({
      data: {
        id,
        kind,
        origin,
        displayNumber: origin === "IMPORTED" ? 0 : 1,
        provider: "CODEX",
        repositoryName: "Example",
        initialPrompt: "Compare model costs",
        model: "model-b",
        inputTokens: 25,
        outputTokens: 12,
        cacheReadTokens: 80,
        cacheWriteTokens: 4,
        modelUsage: {
          create: [
            {
              id: `${id}:model-a`,
              model: "model-a",
              inputTokens: 20,
              outputTokens: 10,
              cacheReadTokens: 80,
              cacheWriteTokens: 4,
            },
            {
              id: `${id}:model-b`,
              model: "model-b",
              inputTokens: 5,
              outputTokens: 2,
            },
          ],
        },
      },
    });

    const detail = (await runs.get(id))!;
    const listed = (await runs.list({ kind })).items.find(
      (row) => row.id === id,
    )!;
    expect(listed.estimatedCost).toBeNull();
    const detailCost = await catalogCost(detail);
    expect(detailCost).toBeCloseTo(0.72);
    expect(await catalogCost(listed)).toBeCloseTo(detailCost!);
  });
});
