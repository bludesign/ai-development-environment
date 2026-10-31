// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { WorkflowEventsService } from "./workflow-events.service";
import { WorkflowsService } from "./workflows.service";

let directory: string;
let prisma: PrismaClient;
let displayNumber = 0;
const service = new WorkflowsService(new WorkflowEventsService());

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-workflow-agent-filter-"));
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
  for (const [id, name] of [
    ["workflow", "Deploy app"],
    ["other", "Build app"],
  ]) {
    await prisma.workflow.create({
      data: { id, name, draftDefinitionJson: "{}" },
    });
    await prisma.workflowVersion.create({
      data: {
        id: `${id}-version`,
        workflowId: id,
        version: 1,
        name,
        definitionJson: "{}",
        contentHash: id,
      },
    });
  }
  await prisma.agent.create({
    data: {
      id: "build",
      name: "Build",
      hostname: "build",
      secretHash: "test",
      version: "1",
      osVersion: "1",
      architecture: "arm64",
      capabilitiesJson: "[]",
    },
  });
  await prisma.codebaseRepository.create({
    data: {
      id: "repository",
      name: "App",
      canonicalOrigin: "https://example.com/app.git",
      displayOrigin: "example/app",
    },
  });
  await prisma.codebase.create({
    data: {
      id: "codebase",
      repositoryId: "repository",
      agentId: "build",
      folder: "/tmp/app",
      observedOrigin: "https://example.com/app.git",
      defaultBranch: "main",
    },
  });
  await prisma.worktree.create({
    data: {
      id: "moved",
      codebaseId: "codebase",
      gitDirectory: "/tmp/app/.git",
      folder: "/tmp/app",
      relativePath: ".",
      branch: "main",
    },
  });
});

beforeEach(async () => {
  await prisma.workflowRun.deleteMany();
  displayNumber = 0;
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function run(
  id: string,
  session: object = { agent: { id: "studio" } },
  overrides: Partial<Prisma.WorkflowRunCreateManyInput> = {},
): Prisma.WorkflowRunCreateManyInput {
  return {
    id,
    displayNumber: ++displayNumber,
    workflowId: "workflow",
    versionId: "workflow-version",
    idempotencyKey: id,
    triggerKind: "MANUAL",
    triggerSubjectKey: id,
    triggerPayloadJson: "{}",
    sessionDataJson: JSON.stringify(session),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

test("matches snapshotted owners and legacy worktrees without matching unrelated runs", async () => {
  const sessions = {
    snapshot: { agent: { id: "studio" }, worktree: { id: "moved" } },
    codebase: { codebase: { agentId: "studio" }, worktree: { id: "moved" } },
    legacy: { worktree: { id: "moved" } },
    empty: { agent: { id: "" }, worktree: { id: "moved" } },
    priority: { agent: { id: "build" }, codebase: { agentId: "studio" } },
    unrelated: { agent: { id: "other" } },
    unassigned: {},
  };
  await prisma.workflowRun.createMany({
    data: Object.entries(sessions).map(([id, session]) => run(id, session)),
  });
  expect(
    (await service.runs({ agentId: "studio" })).items
      .map(({ id }) => id)
      .sort(),
  ).toEqual(["codebase", "snapshot"]);
  expect(
    (await service.runs({ agentId: "build" })).items.map(({ id }) => id).sort(),
  ).toEqual(["empty", "legacy", "priority"]);
  expect(await service.runs({ agentId: "studio' OR 1=1 --" })).toEqual({
    items: [],
    nextCursor: null,
    totalCount: 0,
  });
  expect((await service.runs()).totalCount).toBe(7);
});

test("paginates more than 1,200 matching runs without exceeding bind parameters", async () => {
  const expected = Array.from(
    { length: 1200 },
    (_, index) => `run-${String(index).padStart(4, "0")}`,
  );
  for (let index = 0; index < expected.length; index += 25) {
    await prisma.workflowRun.createMany({
      data: expected.slice(index, index + 25).map((id, offset) =>
        run(id, undefined, {
          createdAt: new Date(
            Date.UTC(2026, 0, 1, 0, 0, Math.floor((index + offset) / 3)),
          ),
        }),
      ),
    });
  }
  await prisma.workflowRun.createMany({
    data: [
      run(
        "other-agent",
        { agent: { id: "other" } },
        { createdAt: new Date("2026-02-01T00:00:00Z") },
      ),
      run("unassigned", {}, { createdAt: new Date("2026-02-01T00:00:00Z") }),
      run("archived", undefined, {
        archivedAt: new Date(),
        createdAt: new Date("2026-02-01T00:00:00Z"),
      }),
    ],
  });

  const seen: string[] = [];
  let after: string | null = null;
  for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
    const page = await service.runs({ agentId: "studio", first: 300, after });
    expect(page.totalCount).toBe(1200);
    expect(page.items).toHaveLength(200);
    expect(page.items[0]).toMatchObject({
      workflow: { id: "workflow" },
      version: { id: "workflow-version" },
      _count: { attempts: 0, events: 0 },
    });
    seen.push(...page.items.map(({ id }) => id));
    expect(page.nextCursor).toBe(pageIndex < 5 ? page.items.at(-1)!.id : null);
    after = page.nextCursor;
  }
  expect(seen).toEqual(expected.toReversed());
  expect(
    (await service.runs({ agentId: "studio", archive: "ALL" })).totalCount,
  ).toBe(1201);
  const archived = await service.runs({
    agentId: "studio",
    archive: "ARCHIVED",
  });
  expect(archived.items.map(({ id }) => id)).toEqual(["archived"]);
  expect(archived.totalCount).toBe(1);
});

test("applies workflow, status and search filters before cursor pagination", async () => {
  await prisma.workflowRun.createMany({
    data: [
      run("deploy-a", undefined, { status: "FAILED", displayNumber: 10 }),
      run("deploy-b", undefined, { status: "FAILED", displayNumber: 11 }),
      run("deploy-c", undefined, { status: "SUCCEEDED", displayNumber: 12 }),
      run("build", undefined, {
        workflowId: "other",
        versionId: "other-version",
        status: "FAILED",
        displayNumber: 13,
      }),
    ],
  });
  const input = {
    agentId: "studio",
    workflowId: "workflow",
    status: "failed",
    search: " DePloY ",
    first: 1,
  };
  const first = await service.runs(input);
  expect(first.items.map(({ id }) => id)).toEqual(["deploy-b"]);
  expect(first.nextCursor).toBe("deploy-b");
  const next = await service.runs({ ...input, after: first.nextCursor });
  expect(next.items.map(({ id }) => id)).toEqual(["deploy-a"]);
  expect(next.nextCursor).toBeNull();
  expect(
    (await service.runs({ agentId: "studio", search: "12" })).items.map(
      ({ id }) => id,
    ),
  ).toEqual(["deploy-c"]);
  expect(
    (await service.runs({ agentId: "studio", search: "missing" })).items,
  ).toEqual([]);
  expect((await service.runs({ ...input, after: "missing" })).items).toEqual(
    [],
  );
  expect(
    (await service.runs({ ...input, after: "deploy-c" })).items.map(
      ({ id }) => id,
    ),
  ).toEqual(["deploy-a"]);
});
