// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import {
  afterAll,
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
import { RunsService, type RunEventInput } from "./runs.service";

let directory: string;
let prisma: InstanceType<typeof PrismaClient>;
const service = new RunsService();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-run-subagents-"));
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
  await prisma.agent.create({
    data: {
      id: "owner",
      name: "Owner",
      hostname: "owner",
      secretHash: "hash",
      version: "1",
      osVersion: "1",
      architecture: "arm64",
      capabilitiesJson: "[]",
    },
  });
});

beforeEach(async () => {
  await prisma.agentRun.deleteMany();
  await seedRun();
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function seedRun(id = "run", displayNumber = 0) {
  await prisma.agentRun.create({
    data: {
      id,
      kind: "SESSION",
      displayNumber,
      provider: "CLAUDE",
      agentId: "owner",
      origin: "MANAGED",
      status: "COMPLETED",
      phase: "COMPLETED",
      repositoryName: "Example",
      model: "opus",
      initialPrompt: "Delegate work",
      inputTokens: 13,
      outputTokens: 7,
      estimatedCost: 0.25,
      attempts: {
        create: {
          id: `${id}-attempt`,
          generation: 0,
          nativeId: `${id}-native`,
          nativeKey: `owner:CLAUDE:${id}-native`,
          status: "COMPLETED",
          rawMetadataJson: "{}",
        },
      },
    },
  });
}

function event(sequence: number, raw: Record<string, unknown>): RunEventInput {
  return {
    id: `live-${sequence}`,
    sequence,
    type: raw.type === "user" ? "USER" : "SYSTEM",
    summary: String(raw.subtype ?? raw.type),
    raw,
    createdAt: `2026-11-04T16:13:${String(20 + sequence).padStart(2, "0")}.000Z`,
  };
}

function snapshot(nativeId = "child", label = "Explore files") {
  return {
    nativeId,
    toolUseId: "spawn-tool",
    label,
    agentType: "Explore",
    status: "COMPLETED",
    prompt: "Find a Swift file",
    finalOutput: "Found Example.swift",
    startedAt: "2026-11-04T16:13:23.000Z",
    finishedAt: "2026-11-04T16:13:30.000Z",
    transcriptStatus: "AVAILABLE" as const,
    messages: [
      { role: "user", content: "Find a Swift file" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-tool",
            name: "Bash",
            input: { command: "find . -name '*.swift'" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-tool",
            content: "Example.swift",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Found Example.swift" }],
      },
    ].map((message, index) => ({
      nativeId: `${nativeId}-message-${index}`,
      createdAt: `2026-11-04T16:13:${23 + index}.000Z`,
      raw: {
        type: message.role,
        uuid: `${nativeId}-message-${index}`,
        agent_id: nativeId,
        parent_tool_use_id: "spawn-tool",
        message,
      },
    })),
  };
}

describe("run subagent sessions", () => {
  test("rejects an attempt owned by another run without persisting its child event", async () => {
    await seedRun("other-run", 1);
    await expect(
      service.appendEvents("owner", "run", "other-run-attempt", [
        event(0, {
          type: "system",
          subtype: "task_started",
          task_id: "wrong-attempt-child",
          task_type: "local_agent",
          description: "Explorer",
        }),
      ]),
    ).rejects.toThrow("Run attempt not found for this run");

    expect(await prisma.runEvent.count()).toBe(0);
    expect(await service.subagents("run")).toEqual([]);
    expect(await service.subagents("other-run")).toEqual([]);
  });

  test("records nested task parent IDs and excludes non-agent background tasks", async () => {
    await service.appendEvents("owner", "run", "run-attempt", [
      event(0, {
        type: "system",
        subtype: "task_started",
        task_id: "parent",
        task_type: "local_agent",
        description: "Parent explorer",
      }),
      event(1, {
        type: "system",
        subtype: "task_started",
        task_id: "nested",
        task_type: "local_agent",
        parent_task_id: "parent",
        description: "Nested explorer",
      }),
      event(2, {
        type: "system",
        subtype: "task_started",
        task_id: "shell-task",
        task_type: "local_bash",
        description: "Background shell command",
      }),
      event(3, {
        type: "system",
        subtype: "task_notification",
        task_id: "shell-task",
        status: "completed",
        summary: "Shell finished",
      }),
    ]);

    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({ nativeId: "parent", parentNativeId: null }),
      expect.objectContaining({ nativeId: "nested", parentNativeId: "parent" }),
    ]);
  });

  test("recovers child messages that arrive before a matching task starts", async () => {
    await service.appendEvents("owner", "run", "run-attempt", [
      event(0, {
        type: "user",
        uuid: "early-prompt",
        parent_tool_use_id: "late-spawn",
        message: { role: "user", content: "Explore early" },
      }),
    ]);
    expect(await service.subagents("run")).toEqual([]);

    await service.appendEvents("owner", "run", "run-attempt", [
      event(1, {
        type: "system",
        subtype: "task_started",
        task_id: "late-child",
        tool_use_id: "late-spawn",
        task_type: "local_agent",
        description: "Late explorer",
      }),
    ]);
    const [agent] = await service.subagents("run");
    expect(agent).toEqual(
      expect.objectContaining({ nativeId: "late-child", messageCount: 1 }),
    );
    const messages = await service.subagentMessages({
      runId: "run",
      subagentId: agent!.id,
    });
    expect(messages.events).toHaveLength(1);
    expect(JSON.parse(messages.events[0]!.rawJson!).uuid).toBe("early-prompt");
  });

  test("marks a completed agent running again when a later task start resumes it", async () => {
    await service.appendEvents("owner", "run", "run-attempt", [
      event(0, {
        type: "system",
        subtype: "task_started",
        task_id: "resumed-child",
        description: "Explorer",
        task_type: "local_agent",
      }),
      event(1, {
        type: "system",
        subtype: "task_notification",
        task_id: "resumed-child",
        status: "completed",
        summary: "First result",
      }),
    ]);
    expect((await service.subagents("run"))[0]!.status).toBe("COMPLETED");
    await service.appendEvents("owner", "run", "run-attempt", [
      event(2, {
        type: "system",
        subtype: "task_started",
        task_id: "resumed-child",
        description: "Explorer resumed",
        task_type: "local_agent",
      }),
    ]);
    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({ nativeId: "resumed-child", status: "RUNNING" }),
    ]);
  });

  test("ignores a late completion from an agent's previous native execution", async () => {
    await service.appendEvents("owner", "run", "run-attempt", [
      event(0, {
        type: "system",
        subtype: "task_started",
        task_id: "resumed-child",
        run_id: "execution-001",
        description: "Explorer",
        task_type: "local_agent",
      }),
      event(1, {
        type: "system",
        subtype: "task_notification",
        task_id: "resumed-child",
        run_id: "execution-001",
        status: "completed",
        summary: "First result",
      }),
    ]);
    await service.appendEvents("owner", "run", "run-attempt", [
      event(2, {
        type: "system",
        subtype: "task_started",
        task_id: "resumed-child",
        run_id: "execution-002",
        description: "Explorer resumed",
        task_type: "local_agent",
      }),
      event(3, {
        type: "system",
        subtype: "task_notification",
        task_id: "resumed-child",
        run_id: "execution-001",
        status: "completed",
        summary: "Stale first result",
      }),
    ]);

    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({
        nativeId: "resumed-child",
        nativeRunId: "execution-002",
        status: "RUNNING",
        finalOutput: null,
        finishedAt: null,
      }),
    ]);
    await service.appendEvents("owner", "run", "run-attempt", [
      event(4, {
        type: "system",
        subtype: "task_notification",
        task_id: "resumed-child",
        run_id: "execution-002",
        status: "completed",
        summary: "Current result",
      }),
    ]);
    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({
        nativeId: "resumed-child",
        nativeRunId: "execution-002",
        status: "COMPLETED",
        finalOutput: "Current result",
      }),
    ]);
  });

  test("keeps a resumed execution running until an unversioned SDK snapshot reaches its completion", async () => {
    const resumedAt = "2026-11-04T16:13:30.000Z";
    const finishedAt = "2026-11-04T16:13:35.000Z";
    await service.appendEvents("owner", "run", "run-attempt", [
      event(0, {
        type: "system",
        subtype: "task_started",
        task_id: "resumed-child",
        run_id: "execution-001",
        description: "Explorer",
        task_type: "local_agent",
      }),
      event(1, {
        type: "system",
        subtype: "task_notification",
        task_id: "resumed-child",
        run_id: "execution-001",
        status: "completed",
        summary: "First result",
      }),
      {
        ...event(2, {
          type: "system",
          subtype: "task_started",
          task_id: "resumed-child",
          run_id: "execution-002",
          description: "Explorer resumed",
          task_type: "local_agent",
        }),
        createdAt: resumedAt,
      },
    ]);
    const lagging = {
      ...snapshot("resumed-child"),
      finishedAt: "2026-11-04T16:13:26.000Z",
      finalOutput: "Old SDK answer",
    };
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "run-native",
        worktreeId: "unused",
        subagents: [lagging],
      },
    ]);

    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({
        nativeId: "resumed-child",
        nativeRunId: "execution-002",
        status: "RUNNING",
        startedAt: new Date(resumedAt),
        finalOutput: null,
        finishedAt: null,
      }),
    ]);
    const current = {
      ...lagging,
      finishedAt,
      finalOutput: "Fresh SDK answer",
      messages: lagging.messages.map((message, index) =>
        index === 3
          ? {
              ...message,
              createdAt: finishedAt,
              raw: {
                ...message.raw,
                timestamp: finishedAt,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Fresh SDK answer" }],
                },
              },
            }
          : message,
      ),
    };
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "run-native",
        worktreeId: "unused",
        subagents: [current],
      },
    ]);

    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({
        nativeId: "resumed-child",
        nativeRunId: "execution-002",
        status: "COMPLETED",
        startedAt: new Date(resumedAt),
        finalOutput: "Fresh SDK answer",
        finishedAt: new Date(finishedAt),
        messageCount: 4,
      }),
    ]);
  });

  test("restores native message order when a full snapshot overlaps an early live result at the same timestamp", async () => {
    const timestamp = "2026-11-04T16:13:25.000Z";
    const child = snapshot();
    const complete = {
      ...child,
      messages: child.messages.map((message) => ({
        ...message,
        createdAt: timestamp,
        raw: { ...message.raw, timestamp },
      })),
    };
    await service.appendEvents("owner", "run", "run-attempt", [
      { ...event(0, complete.messages[2]!.raw), createdAt: timestamp },
    ]);
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "run-native",
        worktreeId: "unused",
        subagents: [complete],
      },
    ]);

    const [agent] = await service.subagents("run");
    expect(agent!.messageCount).toBe(4);
    const page = await service.subagentMessages({
      runId: "run",
      subagentId: agent!.id,
    });
    expect(
      page.events.map((message) => JSON.parse(message.rawJson!).uuid),
    ).toEqual([
      "child-message-0",
      "child-message-1",
      "child-message-2",
      "child-message-3",
    ]);
    const latest = await service.subagentMessages({
      runId: "run",
      subagentId: agent!.id,
      first: 2,
    });
    const earlier = await service.subagentMessages({
      runId: "run",
      subagentId: agent!.id,
      first: 2,
      before: latest.nextCursor,
    });
    expect(
      [...earlier.events, ...latest.events].map(
        (message) => JSON.parse(message.rawJson!).uuid,
      ),
    ).toEqual([
      "child-message-0",
      "child-message-1",
      "child-message-2",
      "child-message-3",
    ]);
    expect(earlier.nextCursor).toBeNull();
  });

  test("lists backfilled agents even when their spawn is outside the initial Activity page", async () => {
    await prisma.runEvent.createMany({
      data: Array.from({ length: 205 }, (_, sequence) => {
        const raw =
          sequence === 0
            ? {
                type: "system",
                subtype: "task_started",
                task_id: "historical-child",
                description: "Historical explorer",
                subagent_type: "Explore",
              }
            : sequence === 204
              ? {
                  type: "system",
                  subtype: "task_notification",
                  task_id: "historical-child",
                  status: "completed",
                  summary: "Finished historical work",
                }
              : { type: "system", subtype: "status" };
        return {
          id: `historical-${sequence}`,
          runId: "run",
          attemptId: "run-attempt",
          sequence,
          type: "SYSTEM",
          summary: "Provider activity",
          searchText: "Provider activity",
          rawJson: JSON.stringify(raw),
        };
      }),
    });
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "run-native",
        worktreeId: "unused",
        subagents: [
          {
            nativeId: "historical-child",
            label: "Historical explorer",
            agentType: "Explore",
            status: "COMPLETED",
            finalOutput: "Finished historical work",
            transcriptStatus: "PARTIAL",
          },
        ],
      },
    ]);

    const activity = await service.events({
      runId: "run",
      first: 200,
      latest: true,
    });
    expect(activity).toHaveLength(200);
    expect(
      activity.some(
        (row) => JSON.parse(row.rawJson!).subtype === "task_started",
      ),
    ).toBe(false);

    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({
        nativeId: "historical-child",
        label: "Historical explorer",
        status: "COMPLETED",
      }),
    ]);
  });

  test("projects interleaved live lifecycle events into separate agents idempotently", async () => {
    const events = [
      event(0, {
        type: "system",
        subtype: "task_started",
        task_id: "child-a",
        tool_use_id: "spawn-a",
        description: "Explore A",
        subagent_type: "Explore",
        prompt: "Find A",
      }),
      event(1, {
        type: "system",
        subtype: "task_started",
        task_id: "child-b",
        tool_use_id: "spawn-b",
        description: "Explore B",
        subagent_type: "Explore",
      }),
      event(2, {
        type: "user",
        agent_id: "child-a",
        parent_tool_use_id: "spawn-a",
        uuid: "prompt-a",
        message: { role: "user", content: "Find A" },
      }),
      event(3, {
        type: "system",
        subtype: "task_progress",
        task_id: "child-a",
        description: "Running file explorer",
      }),
      event(4, {
        type: "system",
        subtype: "task_notification",
        task_id: "child-a",
        tool_use_id: "spawn-a",
        status: "completed",
        summary: "Found A",
      }),
      event(5, {
        type: "system",
        subtype: "task_updated",
        task_id: "child-b",
        patch: { status: "failed" },
      }),
    ];
    await service.appendEvents("owner", "run", "run-attempt", events);
    await service.appendEvents("owner", "run", "run-attempt", events);

    expect(await service.subagents("run")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nativeId: "child-a",
          label: "Explore A",
          status: "COMPLETED",
        }),
        expect.objectContaining({
          nativeId: "child-b",
          label: "Explore B",
          status: "FAILED",
        }),
      ]),
    );
    expect(await service.subagents("run")).toHaveLength(2);
    expect(await prisma.runEvent.count({ where: { runId: "run" } })).toBe(6);
    await expect(
      service.appendEvents("another-owner", "run", "run-attempt", events),
    ).rejects.toThrow("not found");
  });

  test("backfills complete transcripts for managed runs without replacing root history or usage", async () => {
    await prisma.runEvent.create({
      data: {
        id: "root-event",
        runId: "run",
        attemptId: "run-attempt",
        sequence: 0,
        type: "ASSISTANT",
        summary: "Root answer",
        searchText: "Root answer",
        rawJson: '{"root":true}',
      },
    });
    const record = {
      nativeId: "run-native",
      worktreeId: "unused-for-existing-managed-run",
      events: [
        {
          id: "imported-root",
          sequence: 0,
          type: "USER",
          summary: "Replace root",
        },
      ],
      usage: [{ model: "opus", inputTokens: 9999, outputTokens: 9999 }],
      subagents: [snapshot()],
    };
    await service.importRuns("owner", "CLAUDE", [record]);
    await service.importRuns("owner", "CLAUDE", [record]);

    const agents = await service.subagents("run");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual(
      expect.objectContaining({
        nativeId: "child",
        status: "COMPLETED",
        transcriptStatus: "AVAILABLE",
      }),
    );
    const messages = await service.subagentMessages({
      runId: "run",
      subagentId: agents[0]!.id,
    });
    expect(messages.events).toHaveLength(4);
    expect(messages.nextCursor).toBeNull();
    expect(await prisma.runEvent.findMany({ where: { runId: "run" } })).toEqual(
      [
        expect.objectContaining({
          id: "root-event",
          summary: "Root answer",
          rawJson: '{"root":true}',
        }),
      ],
    );
    expect(await prisma.agentRun.findUnique({ where: { id: "run" } })).toEqual(
      expect.objectContaining({
        inputTokens: 13,
        outputTokens: 7,
        estimatedCost: 0.25,
      }),
    );
    await service.appendEvents("owner", "run", "run-attempt", [
      event(1, snapshot().messages[0]!.raw),
    ]);
    expect(await service.subagents("run")).toEqual([
      expect.objectContaining({
        status: "COMPLETED",
        transcriptStatus: "AVAILABLE",
        messageCount: 4,
      }),
    ]);
  });

  test("pages backward within the requested agent and keeps reused native IDs isolated by run", async () => {
    await seedRun("other-run", 1);
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "run-native",
        worktreeId: "unused",
        subagents: [snapshot("shared-child", "First run")],
      },
      {
        nativeId: "other-run-native",
        worktreeId: "unused",
        subagents: [snapshot("shared-child", "Second run")],
      },
    ]);
    const [agent] = await service.subagents("run");
    const [otherAgent] = await service.subagents("other-run");
    expect(agent!.id).not.toBe(otherAgent!.id);
    expect(agent!.label).toBe("First run");
    expect(otherAgent!.label).toBe("Second run");

    const latest = await service.subagentMessages({
      runId: "run",
      subagentId: agent!.id,
      first: 2,
    });
    expect(latest.events.map((row) => JSON.parse(row.rawJson!).uuid)).toEqual([
      "shared-child-message-2",
      "shared-child-message-3",
    ]);
    expect(latest.nextCursor).toBeTruthy();
    const earlier = await service.subagentMessages({
      runId: "run",
      subagentId: agent!.id,
      first: 2,
      before: latest.nextCursor,
    });
    expect(earlier.events.map((row) => JSON.parse(row.rawJson!).uuid)).toEqual([
      "shared-child-message-0",
      "shared-child-message-1",
    ]);
    expect(earlier.nextCursor).toBeNull();

    await expect(
      service.subagentMessages({ runId: "other-run", subagentId: agent!.id }),
    ).rejects.toThrow("Subagent not found for this run");
    const otherPage = await service.subagentMessages({
      runId: "other-run",
      subagentId: otherAgent!.id,
      first: 2,
    });
    await expect(
      service.subagentMessages({
        runId: "run",
        subagentId: agent!.id,
        before: otherPage.nextCursor,
      }),
    ).rejects.toThrow("Subagent message cursor is invalid");
  });

  test("hides superseded attempt sessions and separates reused agent IDs in later attempts", async () => {
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "run-native",
        worktreeId: "unused",
        subagents: [snapshot()],
      },
    ]);
    const [previous] = await service.subagents("run");
    await prisma.runAttempt.update({
      where: { id: "run-attempt" },
      data: { supersededAt: new Date() },
    });
    await prisma.runAttempt.create({
      data: {
        id: "next-attempt",
        runId: "run",
        generation: 1,
        nativeId: "next-native",
        nativeKey: "owner:CLAUDE:next-native",
        status: "COMPLETED",
        rawMetadataJson: "{}",
      },
    });
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "next-native",
        worktreeId: "unused",
        subagents: [snapshot("child", "New attempt")],
      },
    ]);

    const current = await service.subagents("run");
    expect(current).toHaveLength(1);
    expect(current[0]!.id).not.toBe(previous!.id);
    expect(current[0]!.label).toBe("New attempt");
    await expect(
      service.subagentMessages({ runId: "run", subagentId: previous!.id }),
    ).rejects.toThrow("Subagent not found for this run");
  });

  test("retains agent summaries when a native transcript cannot be read", async () => {
    await service.importRuns("owner", "CLAUDE", [
      {
        nativeId: "run-native",
        worktreeId: "unused",
        subagents: [
          {
            ...snapshot(),
            transcriptStatus: "UNAVAILABLE",
            transcriptError: "Transcript file could not be read",
            messages: [],
          },
        ],
      },
    ]);
    const [agent] = await service.subagents("run");
    expect(agent).toEqual(
      expect.objectContaining({
        label: "Explore files",
        finalOutput: "Found Example.swift",
        transcriptStatus: "UNAVAILABLE",
        transcriptError: "Transcript file could not be read",
        messageCount: 0,
      }),
    );
    await expect(
      service.subagentMessages({ runId: "run", subagentId: agent!.id }),
    ).resolves.toEqual({
      events: [],
      nextCursor: null,
    });
  });
});
