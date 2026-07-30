import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { CommandsService, evaluateCommandRestart } from "./commands.service";

const agentControl = () =>
  ({
    registerCompletionHandler: vi.fn(),
    registerConnectionHandler: vi.fn(),
  }) as never;

describe("command restart policy", () => {
  test.each([
    ["NEVER", true, false],
    ["NEVER", false, false],
    ["ON_FAILURE", true, false],
    ["ON_FAILURE", false, true],
    ["ALWAYS", true, true],
    ["ALWAYS", false, true],
  ])("evaluates %s with clean=%s", (policy, clean, expected) => {
    expect(
      evaluateCommandRestart({
        policy,
        clean,
        limit: 3,
        restartCount: 0,
        durationMs: 1_000,
        manualStop: false,
      }).restart,
    ).toBe(expected);
  });

  test("uses a default-sized finite burst and reports exhaustion", () => {
    expect(
      evaluateCommandRestart({
        policy: "ON_FAILURE",
        clean: false,
        limit: 3,
        restartCount: 2,
        durationMs: 1_000,
        manualStop: false,
      }),
    ).toEqual({ restart: true, restartCount: 3, exhausted: false });
    expect(
      evaluateCommandRestart({
        policy: "ON_FAILURE",
        clean: false,
        limit: 3,
        restartCount: 3,
        durationMs: 1_000,
        manualStop: false,
      }),
    ).toEqual({ restart: false, restartCount: 4, exhausted: true });
  });

  test("supports unlimited restarts and resets after one minute", () => {
    expect(
      evaluateCommandRestart({
        policy: "ALWAYS",
        clean: true,
        limit: null,
        restartCount: 99,
        durationMs: 60_000,
        manualStop: false,
      }),
    ).toEqual({ restart: true, restartCount: 1, exhausted: false });
  });

  test("manual termination always suppresses restart", () => {
    expect(
      evaluateCommandRestart({
        policy: "ALWAYS",
        clean: false,
        limit: null,
        restartCount: 4,
        durationMs: 1_000,
        manualStop: true,
      }),
    ).toEqual({ restart: false, restartCount: 4, exhausted: false });
  });
});

describe("command target and output authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  test("stores a complete immutable definition snapshot on each run", async () => {
    const definition = {
      id: "command-1",
      name: "Serve",
      description: "Run the local server",
      script: "npm run dev",
      targetKind: "ANY_AGENT_HOME",
      targetAgentId: null,
      targetRepositoryId: null,
      restartPolicy: "ON_FAILURE",
      restartLimit: 3,
      quickActionEnabled: true,
      quickActionIconKey: "play",
      quickActionButtonVariant: "secondary",
      notificationsEnabled: true,
      archivedAt: null,
      createdAt: new Date("2026-07-25T12:00:00.000Z"),
      updatedAt: new Date("2026-07-25T13:00:00.000Z"),
    };
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      id: "run-1",
      status: "QUEUED",
    }));
    const transaction = {
      commandRunNumberSequence: {
        upsert: vi.fn().mockResolvedValue({ nextValue: 1 }),
      },
      commandRun: { create },
    };
    const commandRunFindUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "run-1" });
    getPrismaClient.mockResolvedValue({
      commandRun: { findUnique: commandRunFindUnique },
      commandDefinition: { findUnique: vi.fn().mockResolvedValue(definition) },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "agent-1",
          name: "Builder",
          hostname: "builder.local",
          capabilitiesJson: '["command.run"]',
        }),
      },
      $transaction: vi
        .fn()
        .mockImplementation(
          (callback: (value: typeof transaction) => unknown) =>
            callback(transaction),
        ),
    });
    const service = new CommandsService(agentControl());
    (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch = vi.fn().mockResolvedValue(undefined);

    await service.startRun({ commandId: definition.id, agentId: "agent-1" });

    const snapshot = JSON.parse(
      String(create.mock.calls[0][0].data.snapshotJson),
    );
    expect(snapshot).toEqual({
      ...definition,
      createdAt: definition.createdAt.toISOString(),
      updatedAt: definition.updatedAt.toISOString(),
    });
  });

  test("stores a custom command only as an immutable run snapshot", async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      id: "run-custom",
      status: "QUEUED",
    }));
    const transaction = {
      commandRunNumberSequence: {
        upsert: vi.fn().mockResolvedValue({ nextValue: 2 }),
      },
      commandRun: { create },
    };
    const commandRunFindUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "run-custom" });
    getPrismaClient.mockResolvedValue({
      commandRun: { findUnique: commandRunFindUnique },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "agent-1",
          name: "Builder",
          hostname: "builder.local",
          capabilitiesJson: '["command.run"]',
        }),
      },
      $transaction: vi
        .fn()
        .mockImplementation(
          (callback: (value: typeof transaction) => unknown) =>
            callback(transaction),
        ),
    });
    const service = new CommandsService(agentControl());
    (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch = vi.fn().mockResolvedValue(undefined);

    await service.startCustomRun({
      script: "  printf custom  ",
      agentId: "agent-1",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commandId: null,
        snapshotName: "Custom command",
        snapshotScript: "printf custom",
        snapshotTargetKind: "ANY_AGENT_HOME",
        snapshotRestartPolicy: "NEVER",
        snapshotRestartLimit: null,
        snapshotNotificationsEnabled: true,
      }),
    });
    expect(JSON.parse(create.mock.calls[0][0].data.snapshotJson)).toEqual(
      expect.objectContaining({
        name: "Custom command",
        script: "printf custom",
        targetKind: "ANY_AGENT_HOME",
      }),
    );
  });

  test("fails a custom run when its initial dispatch is rejected", async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      id: "run-rejected",
      status: "QUEUED",
    }));
    const update = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      id: "run-rejected",
      snapshotName: "Custom command",
      snapshotNotificationsEnabled: true,
      agentName: "Builder",
      agentHostname: "builder.local",
      worktreeId: "worktree-1",
      worktreePath: "/code/project",
      worktreeBranch: "feature/custom",
      worktree: null,
    }));
    const transaction = {
      commandRunNumberSequence: {
        upsert: vi.fn().mockResolvedValue({ nextValue: 3 }),
      },
      commandRun: { create },
    };
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        update,
      },
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          id: "worktree-1",
          folder: "/code/project",
          branch: "feature/custom",
          missingAt: null,
          codebase: {
            repositoryId: "repository-1",
            repository: { id: "repository-1" },
            agent: {
              id: "agent-1",
              name: "Builder",
              hostname: "builder.local",
              capabilitiesJson: '["command.run"]',
            },
          },
        }),
      },
      $transaction: vi
        .fn()
        .mockImplementation(
          (callback: (value: typeof transaction) => unknown) =>
            callback(transaction),
        ),
    });
    const service = new CommandsService(agentControl());
    (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch = vi
      .fn()
      .mockRejectedValue(new Error("Another operation is active"));

    await expect(
      service.startCustomRun({
        script: "pwd",
        worktreeId: "worktree-1",
      }),
    ).rejects.toThrow("Another operation is active");

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-rejected" },
      data: expect.objectContaining({
        status: "FAILED",
        error: "Another operation is active",
        nextRestartAt: null,
      }),
      include: { worktree: { select: { highlightColor: true } } },
    });
  });

  test("requires exactly one custom command target", async () => {
    getPrismaClient.mockResolvedValue({
      commandRun: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    const service = new CommandsService(agentControl());
    await expect(
      service.startCustomRun({
        script: "printf invalid",
        agentId: "agent-1",
        worktreeId: "worktree-1",
      }),
    ).rejects.toThrow("exactly one");
  });

  test("runs a custom command in a concrete worktree", async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      id: "run-worktree",
      status: "QUEUED",
    }));
    const transaction = {
      commandRunNumberSequence: {
        upsert: vi.fn().mockResolvedValue({ nextValue: 3 }),
      },
      commandRun: { create },
    };
    const worktree = {
      id: "worktree-1",
      folder: "/code/project",
      branch: "feature/custom",
      missingAt: null,
      codebase: {
        repositoryId: "repository-1",
        repository: { id: "repository-1" },
        agent: {
          id: "agent-1",
          name: "Builder",
          hostname: "builder.local",
          capabilitiesJson: '["command.run"]',
        },
      },
    };
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "run-worktree" }),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(worktree) },
      $transaction: vi
        .fn()
        .mockImplementation(
          (callback: (value: typeof transaction) => unknown) =>
            callback(transaction),
        ),
    });
    const service = new CommandsService(agentControl());
    (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch = vi.fn().mockResolvedValue(undefined);

    await service.startCustomRun({
      script: "pwd",
      worktreeId: "worktree-1",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commandId: null,
        snapshotTargetKind: "ANY_WORKTREE",
        agentId: "agent-1",
        worktreeId: "worktree-1",
        worktreePath: "/code/project",
        worktreeBranch: "feature/custom",
      }),
    });
  });

  test("reruns the exact original snapshot and concrete target", async () => {
    const original = {
      id: "run-1",
      displayNumber: 10,
      commandId: "command-1",
      status: "SUCCEEDED",
      snapshotName: "Original name",
      snapshotDescription: "Original description",
      snapshotScript: "printf original",
      snapshotTargetKind: "REPOSITORY_WORKTREE",
      snapshotRestartPolicy: "ON_FAILURE",
      snapshotRestartLimit: 2,
      snapshotNotificationsEnabled: false,
      snapshotJson: '{"name":"Original name"}',
      agentId: "agent-1",
      worktreeId: "worktree-1",
      agentName: "Studio",
      agentHostname: "studio.local",
      worktreePath: "/code/project",
      worktreeBranch: "feature/original",
    };
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      id: "run-2",
      status: "QUEUED",
    }));
    const findUnique = vi.fn().mockImplementation(({ where }) => {
      if (where.predecessorRunId) return null;
      if (where.id === original.id) return original;
      return { id: "run-2" };
    });
    const transaction = {
      commandRunNumberSequence: {
        upsert: vi.fn().mockResolvedValue({ nextValue: 11 }),
      },
      commandRun: { create },
    };
    getPrismaClient.mockResolvedValue({
      commandRun: { findUnique },
      $transaction: vi
        .fn()
        .mockImplementation(
          (callback: (value: typeof transaction) => unknown) =>
            callback(transaction),
        ),
    });
    const service = new CommandsService(agentControl());
    const dispatch = vi.fn().mockResolvedValue(undefined);
    (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch = dispatch;

    await service.rerun(original.id);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        snapshotName: original.snapshotName,
        snapshotDescription: original.snapshotDescription,
        snapshotScript: original.snapshotScript,
        snapshotTargetKind: original.snapshotTargetKind,
        snapshotRestartPolicy: original.snapshotRestartPolicy,
        snapshotRestartLimit: original.snapshotRestartLimit,
        snapshotNotificationsEnabled: original.snapshotNotificationsEnabled,
        snapshotJson: original.snapshotJson,
        agentId: original.agentId,
        worktreeId: original.worktreeId,
        worktreePath: original.worktreePath,
        worktreeBranch: original.worktreeBranch,
      }),
    });
    expect(dispatch).toHaveBeenCalledWith("run-2");
  });

  test("filters repository-scoped commands against the global repository", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    getPrismaClient.mockResolvedValue({
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          codebase: { repositoryId: "repository-1" },
        }),
      },
      commandDefinition: { findMany },
    });
    await new CommandsService(agentControl()).eligibleForWorktree("worktree-1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              targetKind: "REPOSITORY_WORKTREE",
              targetRepositoryId: "repository-1",
            }),
          ]),
        }),
      }),
    );
  });

  test("rejects output from another agent or job", async () => {
    getPrismaClient.mockResolvedValue({
      commandRunAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          id: "attempt-1",
          agentJobId: "job-1",
          run: { id: "run-1", agentId: "agent-1" },
        }),
      },
    });
    const service = new CommandsService(agentControl());
    await expect(
      service.appendOutput("agent-2", "job-1", "attempt-1", [
        {
          sequence: 0,
          stream: "STDOUT",
          dataBase64: Buffer.from("x").toString("base64"),
          byteLength: 1,
          createdAt: new Date().toISOString(),
        },
      ]),
    ).rejects.toThrow("not found for this agent job");
  });

  test("upserts ordered raw chunks so retries are idempotent", async () => {
    const chunks = [
      {
        id: "chunk-1",
        attemptId: "attempt-1",
        sequence: 0,
        stream: "STDOUT",
        dataBase64: Buffer.from([0xf0, 0x9f]).toString("base64"),
        byteLength: 2,
        createdAt: new Date(),
      },
      {
        id: "chunk-2",
        attemptId: "attempt-1",
        sequence: 1,
        stream: "STDOUT",
        dataBase64: Buffer.from([0x99, 0x82]).toString("base64"),
        byteLength: 2,
        createdAt: new Date(),
      },
    ];
    const upsert = vi.fn().mockResolvedValue(undefined);
    getPrismaClient.mockResolvedValue({
      commandRunAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          id: "attempt-1",
          attempt: 1,
          runId: "run-1",
          agentJobId: "job-1",
          run: { id: "run-1", agentId: "agent-1" },
        }),
      },
      commandRunOutputChunk: {
        upsert,
        findMany: vi.fn().mockResolvedValue(chunks),
      },
    });
    const service = new CommandsService(agentControl());
    const input = chunks.map((chunk) => ({
      sequence: chunk.sequence,
      stream: chunk.stream,
      dataBase64: chunk.dataBase64,
      byteLength: chunk.byteLength,
      createdAt: chunk.createdAt.toISOString(),
    }));
    await service.appendOutput("agent-1", "job-1", "attempt-1", input);
    await service.appendOutput("agent-1", "job-1", "attempt-1", input);
    expect(upsert).toHaveBeenCalledTimes(4);
    expect(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
      ).toString("utf8"),
    ).toBe("🙂");
  });
});

describe("command reconciliation", () => {
  beforeEach(() => vi.clearAllMocks());

  test("dispatches a due restart before revisiting its completed attempt", async () => {
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-1",
            status: "RESTARTING",
            stopRequested: false,
            nextRestartAt: new Date(0),
            attempts: [
              {
                id: "attempt-1",
                status: "FAILED",
                agentJobId: "job-1",
                agentJob: { id: "job-1", status: "FAILED" },
              },
            ],
          },
        ]),
      },
    });
    const service = new CommandsService(agentControl());
    const dispatch = vi.fn().mockResolvedValue(undefined);
    (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch = dispatch;

    await service.reconcile();

    expect(dispatch).toHaveBeenCalledWith("run-1");
  });

  test("resumes queued dispatch with an incomplete attempt", async () => {
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-1",
            status: "QUEUED",
            stopRequested: false,
            nextRestartAt: null,
            attempts: [
              {
                id: "attempt-1",
                status: "QUEUED",
                agentJobId: null,
                agentJob: null,
                completionProcessedAt: null,
                finishedAt: null,
              },
            ],
          },
        ]),
      },
    });
    const service = new CommandsService(agentControl());
    const dispatch = vi.fn().mockResolvedValue(undefined);
    (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch = dispatch;

    await service.reconcile();

    expect(dispatch).toHaveBeenCalledWith("run-1");
  });

  test("keeps an offline agent job visibly queued until it is claimed", async () => {
    const update = vi.fn().mockResolvedValue({ id: "run-1" });
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-1",
            status: "RUNNING",
            stopRequested: false,
            nextRestartAt: null,
            startedAt: null,
            attempts: [
              {
                id: "attempt-1",
                status: "QUEUED",
                agentJobId: "job-1",
                agentJob: {
                  id: "job-1",
                  status: "QUEUED",
                  startedAt: null,
                },
              },
            ],
          },
        ]),
        update,
      },
    });

    await new CommandsService(agentControl()).reconcile();

    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { status: "QUEUED", startedAt: null },
    });
  });

  test("fails a deleted worktree target instead of falling back to agent home", async () => {
    const update = vi.fn().mockResolvedValue({ id: "run-1" });
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "QUEUED",
          stopRequested: false,
          predecessorRunId: null,
          snapshotTargetKind: "ANY_WORKTREE",
          agentId: "agent-1",
          agent: { capabilitiesJson: '["command.run"]' },
          worktreeId: null,
          worktree: null,
          attempts: [],
        }),
        update,
      },
    });
    const createJob = vi.fn();
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      createJob,
    } as never);

    await (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch("run-1");

    expect(createJob).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "FAILED",
          error: "The command worktree is no longer available",
        }),
      }),
    );
  });

  test("fails a worktree target marked as missing before creating a job", async () => {
    const update = vi.fn().mockResolvedValue({ id: "run-1" });
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "QUEUED",
          stopRequested: false,
          predecessorRunId: null,
          snapshotTargetKind: "ANY_WORKTREE",
          agentId: "agent-1",
          agent: { capabilitiesJson: '["command.run"]' },
          worktreeId: "worktree-1",
          worktree: {
            id: "worktree-1",
            missingAt: new Date(),
            codebase: { agentId: "agent-1" },
          },
          attempts: [],
        }),
        update,
      },
    });
    const createJob = vi.fn();
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      createJob,
    } as never);

    await (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch("run-1");

    expect(createJob).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          error: "The command worktree is no longer available",
        }),
      }),
    );
  });

  test("reuses the latest attempt when dispatch was interrupted before linking its job", async () => {
    const incompleteAttempt = {
      id: "attempt-1",
      runId: "run-1",
      attempt: 1,
      agentJobId: null,
      status: "QUEUED",
      completionProcessedAt: null,
      finishedAt: null,
    };
    const createAttempt = vi.fn();
    const updateAttempt = vi.fn().mockResolvedValue({
      ...incompleteAttempt,
      agentJobId: "job-1",
    });
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "QUEUED",
          stopRequested: false,
          predecessorRunId: null,
          snapshotTargetKind: "ANY_AGENT_HOME",
          snapshotScript: "printf safe",
          agentId: "agent-1",
          agent: { capabilitiesJson: '["command.run"]' },
          worktreeId: null,
          worktree: null,
          startedAt: null,
          attempts: [incompleteAttempt],
        }),
        update: vi.fn().mockResolvedValue({ id: "run-1", status: "QUEUED" }),
      },
      commandRunAttempt: {
        findUnique: vi.fn(),
        create: createAttempt,
        update: updateAttempt,
      },
    });
    const createJob = vi.fn().mockResolvedValue({
      id: "job-1",
      status: "QUEUED",
    });
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      createJob,
    } as never);

    await (
      service as unknown as {
        dispatch: (runId: string) => Promise<void>;
      }
    ).dispatch("run-1");

    expect(createAttempt).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "command-run:run-1:attempt:1",
        payload: expect.objectContaining({ attemptId: "attempt-1" }),
      }),
    );
    expect(updateAttempt).toHaveBeenCalledWith({
      where: { id: "attempt-1" },
      data: { agentJobId: "job-1", status: "QUEUED" },
    });
  });

  test.each([
    ["SUCCEEDED", 0, "COMMAND_RUN_SUCCEEDED", "Deploy succeeded"],
    ["FAILED", 1, "COMMAND_RUN_FAILED", "Deploy failed"],
  ])(
    "records and publishes a %s command notification",
    async (status, exitCode, typeKey, title) => {
      let completeCommand: ((job: never) => Promise<void>) | undefined;
      const notification = { id: "notification-1", typeKey, title };
      const recordInTransaction = vi.fn().mockResolvedValue(notification);
      const created = vi.fn();
      const transaction = {};
      const run = {
        id: "run-1",
        status,
        snapshotName: "Deploy",
        snapshotNotificationsEnabled: true,
        agentName: "Builder",
        agentHostname: "builder.local",
        worktreeId: "worktree-1",
        worktreePath: "/code/project",
        worktreeBranch: "main",
        worktree: { highlightColor: "blue" },
        error: status === "FAILED" ? "Command failed" : null,
      };
      getPrismaClient.mockResolvedValue({
        commandRunAttempt: {
          findUnique: vi.fn().mockResolvedValue({
            id: "attempt-1",
            runId: "run-1",
            completionProcessedAt: null,
            createdAt: new Date(0),
            run: {
              id: "run-1",
              stopRequested: false,
              snapshotRestartPolicy: "NEVER",
              snapshotRestartLimit: 3,
              restartCount: 0,
            },
            agentJob: { startedAt: new Date(0), finishedAt: new Date(1) },
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        commandRun: {
          update: vi.fn().mockResolvedValue(run),
        },
        $transaction: vi.fn((callback) => callback(transaction)),
      });
      new CommandsService(
        {
          registerCompletionHandler: vi.fn((_kind, handler) => {
            completeCommand = handler as typeof completeCommand;
          }),
          registerConnectionHandler: vi.fn(),
        } as never,
        { recordInTransaction, created } as never,
      );

      await completeCommand!({
        id: "job-1",
        status,
        resultJson: JSON.stringify({ exitCode }),
        error: status === "FAILED" ? "Command failed" : null,
      } as never);

      expect(recordInTransaction).toHaveBeenCalledWith(
        transaction,
        expect.objectContaining({
          dedupeKey: `command-run:run-1:${status}`,
          typeKey,
          title,
          body: status === "FAILED" ? "main · Command failed" : "main",
          href: "/commands/runs/run-1",
          resourceKind: "COMMAND_RUN",
          resourceId: "run-1",
          worktreeId: "worktree-1",
          highlightColor: "blue",
        }),
      );
      expect(created).toHaveBeenCalledWith(notification);
    },
  );

  test("honors a command's notification opt-out", async () => {
    let completeCommand: ((job: never) => Promise<void>) | undefined;
    const recordInTransaction = vi.fn();
    getPrismaClient.mockResolvedValue({
      commandRunAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          id: "attempt-1",
          runId: "run-1",
          completionProcessedAt: null,
          createdAt: new Date(0),
          run: {
            id: "run-1",
            stopRequested: false,
            snapshotRestartPolicy: "NEVER",
            snapshotRestartLimit: 3,
            restartCount: 0,
          },
          agentJob: { startedAt: new Date(0), finishedAt: new Date(1) },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      commandRun: {
        update: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "SUCCEEDED",
          snapshotName: "Quiet command",
          snapshotNotificationsEnabled: false,
        }),
      },
    });
    new CommandsService(
      {
        registerCompletionHandler: vi.fn((_kind, handler) => {
          completeCommand = handler as typeof completeCommand;
        }),
        registerConnectionHandler: vi.fn(),
      } as never,
      { recordInTransaction, created: vi.fn() } as never,
    );

    await completeCommand!({
      id: "job-1",
      status: "SUCCEEDED",
      resultJson: JSON.stringify({ exitCode: 0 }),
      error: null,
    } as never);

    expect(recordInTransaction).not.toHaveBeenCalled();
  });
});

describe("CommandsService command definition portability", () => {
  beforeEach(() => vi.clearAllMocks());

  test("exports a scoped command with its target named rather than referenced", async () => {
    getPrismaClient.mockResolvedValue({
      commandDefinition: {
        findUnique: vi.fn().mockResolvedValue({
          id: "command-1",
          name: "Build",
          description: "Builds the app",
          script: "make build",
          targetKind: "REPOSITORY_WORKTREE",
          targetAgentId: null,
          targetRepositoryId: "repository-1",
          targetAgent: null,
          targetRepository: { id: "repository-1", name: "storefront" },
          restartPolicy: "ON_FAILURE",
          restartLimit: 2,
          quickActionEnabled: true,
          quickActionIconKey: "hammer",
          quickActionButtonVariant: "default",
          notificationsEnabled: false,
        }),
      },
    });

    const exported = await new CommandsService(agentControl()).exportDefinition(
      "command-1",
    );

    expect(exported.format).toBe("aide.command.export");
    expect(exported.command).toMatchObject({
      name: "Build",
      script: "make build",
      targetKind: "REPOSITORY_WORKTREE",
      targetRepositoryName: "storefront",
      restartPolicy: "ON_FAILURE",
      restartLimit: 2,
      quickActionEnabled: true,
      notificationsEnabled: false,
    });
    expect(exported.command).not.toHaveProperty("targetRepositoryId");
  });

  test("re-links an imported target by name", async () => {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "command-2", ...data }));
    getPrismaClient.mockResolvedValue({
      agent: { findFirst: vi.fn().mockResolvedValue({ id: "agent-9" }) },
      commandDefinition: { create },
    });

    await new CommandsService(agentControl()).importDefinition({
      payload: {
        format: "aide.command.export",
        command: {
          name: "Restart",
          script: "brew services restart aide",
          targetKind: "SPECIFIC_AGENT_HOME",
          targetAgentName: "studio-mac",
        },
      },
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      name: "Restart",
      targetKind: "SPECIFIC_AGENT_HOME",
      targetAgentId: "agent-9",
    });
  });

  test("widens an imported target that this install does not have", async () => {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "command-3", ...data }));
    getPrismaClient.mockResolvedValue({
      codebaseRepository: { findFirst: vi.fn().mockResolvedValue(null) },
      commandDefinition: { create },
    });

    await new CommandsService(agentControl()).importDefinition({
      payload: {
        name: "Test",
        script: "npm test",
        targetKind: "REPOSITORY_WORKTREE",
        targetRepositoryName: "missing",
      },
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      targetKind: "ANY_WORKTREE",
      targetRepositoryId: null,
    });
  });

  test("keeps commands that have run history out of delete", async () => {
    const del = vi.fn();
    getPrismaClient.mockResolvedValue({
      commandDefinition: {
        findUnique: vi.fn().mockResolvedValue({ id: "command-1" }),
        delete: del,
      },
      commandRun: { count: vi.fn().mockResolvedValue(3) },
    });

    await expect(
      new CommandsService(agentControl()).deleteDefinition("command-1"),
    ).rejects.toThrow("Archive commands that have run history");
    expect(del).not.toHaveBeenCalled();
  });

  test("deletes a command with no run history", async () => {
    const del = vi.fn().mockResolvedValue({ id: "command-1" });
    getPrismaClient.mockResolvedValue({
      commandDefinition: {
        findUnique: vi.fn().mockResolvedValue({ id: "command-1" }),
        delete: del,
      },
      commandRun: { count: vi.fn().mockResolvedValue(0) },
    });

    await expect(
      new CommandsService(agentControl()).deleteDefinition("command-1"),
    ).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "command-1" } });
  });
});
