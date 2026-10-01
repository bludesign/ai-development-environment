// @vitest-environment node
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { expect, test } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { workflowRunIdsForAgent } from "./workflow-run-agent-filter";

test("matches snapshotted owners and legacy worktrees without matching unrelated runs", async () => {
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
  });
  try {
    await prisma.$executeRaw`CREATE TABLE WorkflowRun (id TEXT PRIMARY KEY, sessionDataJson TEXT)`;
    await prisma.$executeRaw`CREATE TABLE Worktree (id TEXT PRIMARY KEY, codebaseId TEXT)`;
    await prisma.$executeRaw`CREATE TABLE Codebase (id TEXT PRIMARY KEY, agentId TEXT)`;
    await prisma.$executeRaw`INSERT INTO Codebase VALUES ('codebase', 'build')`;
    await prisma.$executeRaw`INSERT INTO Worktree VALUES ('moved', 'codebase')`;
    const sessions = {
      snapshot: { agent: { id: "studio" }, worktree: { id: "moved" } },
      codebase: { codebase: { agentId: "studio" }, worktree: { id: "moved" } },
      legacy: { worktree: { id: "moved" } },
      empty: { agent: { id: "" }, worktree: { id: "moved" } },
      priority: { agent: { id: "build" }, codebase: { agentId: "studio" } },
      unrelated: { agent: { id: "other" } },
      unassigned: {},
    };
    for (const [id, session] of Object.entries(sessions)) {
      await prisma.$executeRaw`INSERT INTO WorkflowRun VALUES (${id}, ${JSON.stringify(session)})`;
    }
    expect((await workflowRunIdsForAgent(prisma, "studio")).sort()).toEqual([
      "codebase",
      "snapshot",
    ]);
    expect((await workflowRunIdsForAgent(prisma, "build")).sort()).toEqual([
      "empty",
      "legacy",
      "priority",
    ]);
    expect(await workflowRunIdsForAgent(prisma, "studio' OR 1=1 --")).toEqual(
      [],
    );
  } finally {
    await prisma.$disconnect();
  }
});
