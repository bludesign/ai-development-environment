import Database from "better-sqlite3";
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import { loadCommandTargetSummaries } from "./command-target-summaries";

const definition = (id: string, targetKind = "ANY_AGENT_HOME", extra = {}) => ({
  id,
  name: id,
  description: "",
  targetKind,
  targetAgentId: null,
  quickActionEnabled: true,
  quickActionIconKey: "terminal",
  quickActionButtonVariant: "default",
  repositories: [],
  ...extra,
});
const setup = (
  definitions = [definition("any")],
  runs: Record<string, unknown>[] = [],
) => {
  const prisma = {
    worktree: {
      findMany: vi.fn().mockResolvedValue([
        { id: "w1", codebase: { repositoryId: "r1" } },
        { id: "w2", codebase: { repositoryId: "r2" } },
      ]),
    },
    commandDefinition: { findMany: vi.fn().mockResolvedValue(definitions) },
    commandRun: { findMany: vi.fn().mockResolvedValue(runs), count: vi.fn() },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
  getPrismaClient.mockResolvedValue(prisma);
  return prisma;
};
beforeEach(() => getPrismaClient.mockReset());

describe("batched command target summaries", () => {
  test("four agents share definition and active reads, without relation hydration or a global limit", async () => {
    const runs = Array.from({ length: 51 }, (_, index) => ({
      id: `a-run-${index}`,
      agentId: "a",
      worktreeId: null,
      commandId: "any",
      displayNumber: index + 1,
      status: "RUNNING",
    }));
    runs.push({
      id: "b-run",
      agentId: "b",
      worktreeId: null,
      commandId: "any",
      displayNumber: 52,
      status: "RUNNING",
    });
    const prisma = setup([definition("any")], runs);
    const results = await loadCommandTargetSummaries(
      ["a", "b", "c", "d"].map((resourceId) => ({
        resourceKind: "AGENT",
        resourceId,
      })),
    );
    expect(prisma.commandDefinition.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.commandRun.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.commandRun.count).not.toHaveBeenCalled();
    expect(prisma.worktree.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.commandRun.findMany.mock.calls[0][0]).toEqual({
      where: {
        archivedAt: null,
        status: { in: ["QUEUED", "RUNNING", "RESTARTING", "CANCELLING"] },
        OR: ["a", "b", "c", "d"].map((agentId) => ({
          agentId,
          commandId: { in: ["any"] },
        })),
      },
      select: {
        id: true,
        commandId: true,
        agentId: true,
        worktreeId: true,
        displayNumber: true,
        status: true,
      },
      orderBy: { displayNumber: "asc" },
    });
    expect(results[0].activeRuns).toHaveLength(51);
    expect(results[1].activeRuns.map((run) => run.id)).toEqual(["b-run"]);
    expect(results[2].activeRuns).toEqual([]);
    expect(
      prisma.commandDefinition.findMany.mock.calls[0][0],
    ).not.toHaveProperty("include");
    expect(
      prisma.commandDefinition.findMany.mock.calls[0][0].select,
    ).not.toHaveProperty("script");
  });

  test("mixed targets preserve agent/repository eligibility and merge duplicate requirements", async () => {
    const prisma = setup([
      definition("home"),
      definition("specific", "SPECIFIC_AGENT_HOME", { targetAgentId: "a" }),
      definition("worktree", "ANY_WORKTREE"),
      definition("repository", "REPOSITORY_WORKTREE", {
        repositories: [{ repositoryId: "r1" }],
      }),
      definition("manual", "ANY_AGENT_HOME", { quickActionEnabled: false }),
    ]);
    const result = await loadCommandTargetSummaries([
      { resourceKind: "AGENT", resourceId: "a" },
      {
        resourceKind: "AGENT",
        resourceId: "a",
        includeAllCommands: true,
        includeRecentRuns: true,
      },
      { resourceKind: "AGENT", resourceId: "b" },
      { resourceKind: "WORKTREE", resourceId: "w1" },
      { resourceKind: "WORKTREE", resourceId: "w2" },
      { resourceKind: "WORKTREE", resourceId: "missing" },
    ]);
    expect(
      result.map((summary) => summary.commands.map((command) => command.id)),
    ).toEqual([
      ["home", "specific", "manual"],
      ["home"],
      ["worktree", "repository"],
      ["worktree"],
      [],
    ]);
    expect(prisma.worktree.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.commandDefinition.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(result[0].commands[0]).not.toHaveProperty("repositories");
    expect(result[0].commands[0]).not.toHaveProperty("targetAgentId");
  });

  test("empty eligibility avoids any active/history read and returns keyed empty results", async () => {
    const prisma = setup([]);
    expect(
      await loadCommandTargetSummaries([
        { resourceKind: "AGENT", resourceId: "a" },
      ]),
    ).toEqual([
      {
        resourceKind: "AGENT",
        resourceId: "a",
        commands: [],
        activeRuns: [],
        recentRuns: [],
      },
    ]);
    expect(prisma.commandRun.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test("recent SQL preserves eight newest unarchived rows for each target independently", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE CommandRun (id TEXT, snapshotName TEXT, displayNumber INTEGER, status TEXT, createdAt INTEGER, archivedAt INTEGER, agentId TEXT, worktreeId TEXT)",
      );
      const insert = db.prepare(
        "INSERT INTO CommandRun VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let index = 1; index <= 60; index++)
        insert.run(
          `a${index}`,
          "A",
          index,
          "SUCCEEDED",
          index,
          null,
          "a",
          "w1",
        );
      insert.run("b", "B", 61, "FAILED", 61, null, "b", "w2");
      insert.run("archived", "Archived", 62, "SUCCEEDED", 62, 63, "b", "w2");
      const prisma = setup([]);
      prisma.$queryRawUnsafe.mockImplementation(async (sql, ...args) =>
        db
          .prepare(sql)
          .safeIntegers()
          .all(...args),
      );
      const result = await loadCommandTargetSummaries([
        { resourceKind: "AGENT", resourceId: "a", includeRecentRuns: true },
        { resourceKind: "AGENT", resourceId: "b", includeRecentRuns: true },
        { resourceKind: "WORKTREE", resourceId: "w1", includeRecentRuns: true },
      ]);
      expect(result[0].recentRuns.map((run) => run.id)).toEqual([
        "a60",
        "a59",
        "a58",
        "a57",
        "a56",
        "a55",
        "a54",
        "a53",
      ]);
      expect(result[1].recentRuns.map((run) => run.id)).toEqual(["b"]);
      expect(result[2].recentRuns).toEqual(result[0].recentRuns);
      expect(result[1].recentRuns[0].createdAt).toEqual(
        new Date(61).toISOString(),
      );
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  test("rejects invalid/unbounded inputs before reading the database", async () => {
    await expect(
      loadCommandTargetSummaries([{ resourceKind: "AGENT", resourceId: " " }]),
    ).rejects.toThrow("Invalid command target");
    await expect(
      loadCommandTargetSummaries(
        Array.from({ length: 201 }, () => ({
          resourceKind: "AGENT",
          resourceId: "a",
        })),
      ),
    ).rejects.toThrow("200");
    expect(getPrismaClient).not.toHaveBeenCalled();
    expect(await loadCommandTargetSummaries([])).toEqual([]);
  });
});
