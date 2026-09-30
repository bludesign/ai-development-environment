// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { PrismaClient } from "@/generated/prisma/client";
import { RunsService } from "./runs.service";

let directory: string;
let prisma: InstanceType<typeof PrismaClient>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-run-agent-filter-"));
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
  await prisma.agent.createMany({
    data: ["studio", "build"].map((id) => ({
      id,
      name: id,
      hostname: id,
      secretHash: id,
      version: "1",
      osVersion: "1",
      architecture: "arm64",
      capabilitiesJson: "[]",
    })),
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each(["PLAN", "SESSION"])(
  "filters %s before pagination and counts only the selected agent",
  async (kind) => {
    const rows = [
      { agentId: "studio", archivedAt: null },
      { agentId: "studio", archivedAt: null },
      { agentId: "build", archivedAt: null },
      { agentId: null, archivedAt: null },
      { agentId: "studio", archivedAt: new Date() },
    ];
    await prisma.agentRun.createMany({
      data: rows.map((row, index) => ({
        ...row,
        id: `${kind}-${index}`,
        kind,
        displayNumber: index,
        provider: "CODEX",
        repositoryName: "Example",
        initialPrompt: "Prompt",
        model: "model",
        createdAt: new Date(2026, 0, index + 1),
      })),
    });
    const service = new RunsService();
    const first = await service.list({ kind, agentId: "studio", first: 1 });
    expect(first.items.map(({ id }) => id)).toEqual([`${kind}-1`]);
    expect(first.totalCount).toBe(2);
    expect(first.nextCursor).toBe(`${kind}-1`);
    const next = await service.list({
      kind,
      agentId: "studio",
      first: 1,
      after: first.nextCursor,
    });
    expect(next.items.map(({ id }) => id)).toEqual([`${kind}-0`]);
    expect(next.totalCount).toBe(2);
    expect(next.nextCursor).toBeNull();
    const archived = await service.list({
      kind,
      agentId: "studio",
      archive: "ARCHIVED",
    });
    expect(archived.items.map(({ id }) => id)).toEqual([`${kind}-4`]);
    expect(archived.totalCount).toBe(1);
    expect((await service.list({ kind })).totalCount).toBe(4);
  },
);
