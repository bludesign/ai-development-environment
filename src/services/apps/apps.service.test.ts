// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { PrismaClient } from "@/generated/prisma/client";
import type { AgentControlService } from "@/services/agent-control";
import { CodebasesService } from "@/services/codebases";

import { AppsService } from "./apps.service";

describe("AppsService", () => {
  let templateDirectory: string;
  let templateDatabasePath: string;
  let directory: string;
  let prisma: InstanceType<typeof PrismaClient>;

  beforeAll(async () => {
    templateDirectory = await mkdtemp(join(tmpdir(), "aide-apps-template-"));
    templateDatabasePath = join(templateDirectory, "template.db");
    const database = new Database(templateDatabasePath);
    database.pragma("foreign_keys = ON");
    const migrationsRoot = resolve(process.cwd(), "prisma/migrations");
    for (const migration of readdirSync(migrationsRoot).toSorted()) {
      const path = join(migrationsRoot, migration, "migration.sql");
      if (existsSync(path)) database.exec(readFileSync(path, "utf8"));
    }
    database.close();
  }, 60_000);

  afterAll(async () => {
    await rm(templateDirectory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aide-apps-"));
    const databasePath = join(directory, "test.db");
    await copyFile(templateDatabasePath, databasePath);
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: databasePath }),
    });
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await prisma.agent.create({
      data: {
        id: "agent-1",
        name: "Agent",
        hostname: "agent.local",
        version: "1.0.0",
        osVersion: "macOS",
        architecture: "arm64",
        capabilitiesJson: "[]",
        secretHash: "agent-secret",
      },
    });
    for (const [id, name] of [
      ["repository-1", "Web"],
      ["repository-2", "iOS"],
    ] as const) {
      await prisma.codebaseRepository.create({
        data: {
          id,
          canonicalOrigin: `https://example.com/${name.toLowerCase()}.git`,
          displayOrigin: `example/${name.toLowerCase()}`,
          name,
        },
      });
    }
    await prisma.codebase.create({
      data: {
        id: "codebase-1",
        repositoryId: "repository-1",
        agentId: "agent-1",
        folder: "/tmp/web",
        observedOrigin: "https://example.com/web.git",
      },
    });
    await prisma.worktree.create({
      data: {
        id: "worktree-1",
        codebaseId: "codebase-1",
        gitDirectory: "/tmp/web/.git",
        folder: "/tmp/web",
        relativePath: ".",
        primary: true,
      },
    });
    await prisma.agentRun.createMany({
      data: [
        {
          id: "plan-1",
          kind: "PLAN",
          displayNumber: 1,
          provider: "CODEX",
          worktreeId: "worktree-1",
          repositoryName: "Web",
          model: "gpt-test",
          initialPrompt: "Plan",
        },
        {
          id: "session-1",
          kind: "SESSION",
          displayNumber: 1,
          provider: "CODEX",
          worktreeId: "worktree-1",
          repositoryName: "Web",
          model: "gpt-test",
          initialPrompt: "Build",
        },
      ],
    });
    await prisma.build.create({
      data: {
        id: "build-1",
        requestKey: "build-request-1",
        requestId: "request-1",
        codebaseId: "codebase-1",
        worktreeId: "worktree-1",
        action: "BUILD",
        destinationType: "SIMULATOR",
        destinationJson: "{}",
        snapshotJson: "{}",
        commandSummary: "xcodebuild",
        artifactDirectory: "/tmp/build-1",
      },
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("creates apps with scoped resource totals and case-insensitive names", async () => {
    const service = new AppsService();
    const app = await service.create({
      name: "Customer Portal",
      description: "Web and mobile",
      repositoryIds: ["repository-1", "repository-2", "repository-1"],
    });

    expect(app.repositories.map((repository) => repository.id)).toEqual([
      "repository-1",
      "repository-2",
    ]);
    expect(
      app.repositories[0]?.codebases.map((codebase) => codebase.id),
    ).toEqual(["codebase-1"]);
    expect(app.repositories[1]?.codebases).toEqual([]);
    expect(app.counts).toEqual({
      repositories: 2,
      codebases: 1,
      worktrees: 1,
      plans: 1,
      sessions: 1,
      builds: 1,
    });
    await expect(
      service.create({
        name: "customer portal",
        repositoryIds: ["repository-1"],
      }),
    ).rejects.toThrow("App names must be unique");
  });

  test("updates assignments, deletes only the grouping, and preserves assigned repositories without checkouts", async () => {
    const service = new AppsService();
    const app = await service.create({
      name: "Console",
      repositoryIds: ["repository-1"],
    });
    const codebases = new CodebasesService({
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService);

    const removal = await codebases.removeCodebase("codebase-1");
    expect(removal.repositoryRemoved).toBe(false);
    expect(
      await prisma.codebaseRepository.findUnique({
        where: { id: "repository-1" },
      }),
    ).not.toBeNull();

    const updated = await service.update({
      id: app.id,
      name: "Console",
      description: "Native only",
      repositoryIds: ["repository-2"],
    });
    expect(updated.repositories.map((repository) => repository.id)).toEqual([
      "repository-2",
    ]);

    await service.delete(app.id);
    expect(await service.get(app.id)).toBeNull();
    expect(await prisma.codebaseRepository.count()).toBe(2);
  });
});
