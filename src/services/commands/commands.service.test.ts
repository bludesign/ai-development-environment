import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  CommandsService,
  admitCommandRun,
  evaluateCommandRestart,
} from "./commands.service";

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

describe("CommandsService.terminateRun", () => {
  beforeEach(() => vi.clearAllMocks());

  const terminateWith = async (job: { status: string } | null) => {
    const update = vi
      .fn()
      .mockResolvedValue({ id: "run-1", status: "CANCELLING" });
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: "run-1",
            status: "RESTARTING",
            attempts: [{ id: "attempt-3", agentJobId: job ? "job-3" : null }],
          })
          .mockResolvedValue(null),
        update,
      },
    });
    const cancelJob = vi.fn().mockResolvedValue(job);
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      cancelJob,
    } as never);
    await service.terminateRun("run-1");
    return { update, cancelJob };
  };

  test("closes out a run whose newest attempt already finished", async () => {
    // Terminating a run waiting to restart used to leave it in CANCELLING:
    // cancelJob is a no-op on a job that already failed, and nothing else
    // finished the run.
    const { update } = await terminateWith({ status: "FAILED" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  test("waits for the agent when the cancel reached a live job", async () => {
    const { update, cancelJob } = await terminateWith({ status: "CANCELLING" });
    expect(cancelJob).toHaveBeenCalledWith("job-3");
    expect(
      update.mock.calls.some(
        ([call]) =>
          (call as { data: { status: string } }).data.status === "CANCELLED",
      ),
    ).toBe(false);
  });
});

describe("command concurrency admission", () => {
  const at = (minute: number) => new Date(`2026-08-02T10:0${minute}:00Z`);
  const peer = (id: string, concurrency: string, minute: number) => ({
    id,
    concurrency,
    queuedAt: at(minute),
  });

  test("lets non-exclusive runs share a target", () => {
    expect(
      admitCommandRun({
        candidate: peer("candidate", "NON_EXCLUSIVE", 1),
        holders: [peer("holder", "NON_EXCLUSIVE", 0)],
        waiting: [],
      }),
    ).toBe(true);
  });

  test("holds an exclusive run while any non-excluded run owns the target", () => {
    expect(
      admitCommandRun({
        candidate: peer("candidate", "EXCLUSIVE", 1),
        holders: [peer("holder", "NON_EXCLUSIVE", 0)],
        waiting: [],
      }),
    ).toBe(false);
  });

  test("holds a non-exclusive run while an exclusive run owns the target", () => {
    expect(
      admitCommandRun({
        candidate: peer("candidate", "NON_EXCLUSIVE", 1),
        holders: [peer("holder", "EXCLUSIVE", 0)],
        waiting: [],
      }),
    ).toBe(false);
  });

  test("admits an excluded run against an exclusive holder", () => {
    expect(
      admitCommandRun({
        candidate: peer("candidate", "EXCLUDED", 1),
        holders: [peer("holder", "EXCLUSIVE", 0)],
        waiting: [peer("older", "EXCLUSIVE", 0)],
      }),
    ).toBe(true);
  });

  test("ignores excluded runs when deciding for everyone else", () => {
    expect(
      admitCommandRun({
        candidate: peer("candidate", "EXCLUSIVE", 1),
        holders: [peer("holder", "EXCLUDED", 0)],
        waiting: [peer("older", "EXCLUDED", 0)],
      }),
    ).toBe(true);
  });

  test("admits only the oldest of two exclusive runs racing for a free target", () => {
    const older = peer("older", "EXCLUSIVE", 0);
    const newer = peer("newer", "EXCLUSIVE", 1);
    expect(
      admitCommandRun({ candidate: older, holders: [], waiting: [newer] }),
    ).toBe(true);
    expect(
      admitCommandRun({ candidate: newer, holders: [], waiting: [older] }),
    ).toBe(false);
  });

  test("breaks a tied queue timestamp by id so both runs agree on the winner", () => {
    const first = { id: "run-a", concurrency: "EXCLUSIVE", queuedAt: at(0) };
    const second = { id: "run-b", concurrency: "EXCLUSIVE", queuedAt: at(0) };
    expect(
      admitCommandRun({ candidate: first, holders: [], waiting: [second] }),
    ).toBe(true);
    expect(
      admitCommandRun({ candidate: second, holders: [], waiting: [first] }),
    ).toBe(false);
  });

  test("makes a shared run yield to an exclusive run queued ahead of it", () => {
    // Without this a steady stream of non-exclusive work would keep the target
    // occupied and the exclusive run would never reach the front.
    expect(
      admitCommandRun({
        candidate: peer("candidate", "NON_EXCLUSIVE", 2),
        holders: [],
        waiting: [peer("exclusive", "EXCLUSIVE", 1)],
      }),
    ).toBe(false);
    expect(
      admitCommandRun({
        candidate: peer("candidate", "NON_EXCLUSIVE", 0),
        holders: [],
        waiting: [peer("exclusive", "EXCLUSIVE", 1)],
      }),
    ).toBe(true);
  });
});

describe("command concurrency dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  const dispatchWith = async (input: {
    candidate: string;
    peers: Array<{
      id: string;
      snapshotConcurrency: string;
      queuedAt: Date;
      attempts: Array<{
        agentJobId: string | null;
        completionProcessedAt: Date | null;
      }>;
    }>;
  }) => {
    const createAttempt = vi.fn().mockResolvedValue({
      id: "attempt-1",
      agentJobId: null,
      status: "QUEUED",
    });
    const findMany = vi.fn().mockResolvedValue(input.peers);
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "QUEUED",
          stopRequested: false,
          predecessorRunId: null,
          snapshotTargetKind: "ANY_WORKTREE",
          snapshotScript: "printf safe",
          snapshotConcurrency: input.candidate,
          queuedAt: new Date("2026-08-02T10:05:00Z"),
          agentId: "agent-1",
          agent: { capabilitiesJson: '["command.run"]' },
          worktreeId: "worktree-1",
          worktree: { missingAt: null, codebase: { agentId: "agent-1" } },
          startedAt: null,
          attempts: [],
        }),
        findMany,
        update: vi.fn().mockResolvedValue({ id: "run-1", status: "QUEUED" }),
      },
      commandRunAttempt: {
        findUnique: vi.fn(),
        create: createAttempt,
        update: vi
          .fn()
          .mockResolvedValue({ id: "attempt-1", agentJobId: "job-1" }),
      },
    });
    const createJob = vi
      .fn()
      .mockResolvedValue({ id: "job-1", status: "QUEUED" });
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      createJob,
    } as never);
    await (
      service as unknown as { dispatch: (runId: string) => Promise<void> }
    ).dispatch("run-1");
    return { createJob, createAttempt, findMany };
  };

  const holder = (id: string, concurrency: string) => ({
    id,
    snapshotConcurrency: concurrency,
    queuedAt: new Date("2026-08-02T10:00:00Z"),
    attempts: [{ agentJobId: "job-held", completionProcessedAt: null }],
  });

  test("queues an exclusive run rather than failing it when the target is busy", async () => {
    const { createJob, createAttempt } = await dispatchWith({
      candidate: "EXCLUSIVE",
      peers: [holder("run-0", "NON_EXCLUSIVE")],
    });
    expect(createJob).not.toHaveBeenCalled();
    // The attempt row is withheld too, so a blocked run does not burn an
    // attempt number on every reconcile tick.
    expect(createAttempt).not.toHaveBeenCalled();
  });

  test("starts a non-exclusive run beside another non-exclusive run", async () => {
    const { createJob } = await dispatchWith({
      candidate: "NON_EXCLUSIVE",
      peers: [holder("run-0", "NON_EXCLUSIVE")],
    });
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  test("starts an excluded run without consulting the target at all", async () => {
    const { createJob, findMany } = await dispatchWith({
      candidate: "EXCLUDED",
      peers: [holder("run-0", "EXCLUSIVE")],
    });
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  test("treats a queued peer without a job as waiting rather than holding", async () => {
    const { createJob } = await dispatchWith({
      candidate: "EXCLUSIVE",
      peers: [
        {
          id: "run-0",
          snapshotConcurrency: "NON_EXCLUSIVE",
          // Queued after the candidate, so it is behind it in line and the
          // candidate may still take the free target.
          queuedAt: new Date("2026-08-02T10:06:00Z"),
          attempts: [{ agentJobId: null, completionProcessedAt: null }],
        },
      ],
    });
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  test("keeps a run queued when the codebase is held by other work", async () => {
    const createAttempt = vi.fn().mockResolvedValue({
      id: "attempt-1",
      agentJobId: null,
      status: "QUEUED",
    });
    const updateRun = vi.fn();
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "QUEUED",
          stopRequested: false,
          predecessorRunId: null,
          snapshotTargetKind: "ANY_WORKTREE",
          snapshotScript: "printf safe",
          snapshotConcurrency: "NON_EXCLUSIVE",
          queuedAt: new Date("2026-08-02T10:05:00Z"),
          agentId: "agent-1",
          agent: { capabilitiesJson: '["command.run"]' },
          worktreeId: "worktree-1",
          worktree: { missingAt: null, codebase: { agentId: "agent-1" } },
          startedAt: null,
          attempts: [],
        }),
        findMany: vi.fn().mockResolvedValue([]),
        update: updateRun,
      },
      commandRunAttempt: {
        findUnique: vi.fn(),
        create: createAttempt,
        update: vi.fn(),
      },
    });
    const busy = Object.assign(
      new Error("Another operation is active for this codebase"),
      { name: "CodebaseBusyError" },
    );
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      createJob: vi.fn().mockRejectedValue(busy),
    } as never);

    await expect(
      (
        service as unknown as { dispatch: (runId: string) => Promise<void> }
      ).dispatch("run-1"),
    ).resolves.toBeUndefined();
    expect(updateRun).not.toHaveBeenCalled();
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

  test.each([
    ["FAILED", "a restart waiting after a failed attempt"],
    ["SUCCEEDED", "a restart waiting after a clean attempt"],
    ["TIMED_OUT", "a restart waiting after a timed-out attempt"],
    ["CANCELLED", "an attempt the agent already cancelled"],
  ])(
    "finishes a stop request whose newest job is %s (%s)",
    async (jobStatus) => {
      // The agent cannot cancel a job that already reported back, so a stop
      // requested between attempts left the run stuck in CANCELLING forever.
      const update = vi
        .fn()
        .mockResolvedValue({ id: "run-1", status: "CANCELLED" });
      const cancelJob = vi.fn();
      getPrismaClient.mockResolvedValue({
        commandRun: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "run-1",
              status: "CANCELLING",
              stopRequested: true,
              nextRestartAt: null,
              attempts: [
                {
                  id: "attempt-3",
                  status: jobStatus,
                  agentJobId: "job-3",
                  agentJob: { id: "job-3", status: jobStatus },
                  completionProcessedAt: new Date(),
                },
              ],
            },
          ]),
          findUnique: vi.fn().mockResolvedValue(null),
          update,
        },
      });
      const service = new CommandsService({
        registerCompletionHandler: vi.fn(),
        registerConnectionHandler: vi.fn(),
        cancelJob,
      } as never);

      await service.reconcile();

      expect(cancelJob).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1" },
          data: expect.objectContaining({ status: "CANCELLED" }),
        }),
      );
    },
  );

  test("still asks the agent to cancel a job that is running", async () => {
    const cancelJob = vi.fn().mockResolvedValue({ id: "job-1" });
    const update = vi.fn();
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-1",
            status: "CANCELLING",
            stopRequested: true,
            nextRestartAt: null,
            attempts: [
              {
                id: "attempt-1",
                status: "RUNNING",
                agentJobId: "job-1",
                agentJob: { id: "job-1", status: "RUNNING" },
                completionProcessedAt: null,
              },
            ],
          },
        ]),
        findUnique: vi.fn().mockResolvedValue(null),
        update,
      },
    });
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      cancelJob,
    } as never);

    await service.reconcile();

    expect(cancelJob).toHaveBeenCalledWith("job-1");
    expect(update).not.toHaveBeenCalled();
  });

  test("finishes a stop request for a run that never reached a job", async () => {
    // A run held back by concurrency has no job to cancel, so terminating it
    // has to close it out directly.
    const update = vi
      .fn()
      .mockResolvedValue({ id: "run-1", status: "CANCELLED" });
    const cancelJob = vi.fn();
    getPrismaClient.mockResolvedValue({
      commandRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "run-1",
            status: "CANCELLING",
            stopRequested: true,
            nextRestartAt: null,
            attempts: [
              {
                id: "attempt-1",
                status: "QUEUED",
                agentJobId: null,
                agentJob: null,
                completionProcessedAt: null,
              },
            ],
          },
        ]),
        findUnique: vi.fn().mockResolvedValue(null),
        update,
      },
    });
    const service = new CommandsService({
      registerCompletionHandler: vi.fn(),
      registerConnectionHandler: vi.fn(),
      cancelJob,
    } as never);

    await service.reconcile();

    expect(cancelJob).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
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
          queuedAt: new Date("2026-08-02T10:00:00Z"),
          snapshotConcurrency: "NON_EXCLUSIVE",
          attempts: [incompleteAttempt],
        }),
        findMany: vi.fn().mockResolvedValue([]),
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

  test("turns off the quick action when a target had to be widened", async () => {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "command-4", ...data }));
    getPrismaClient.mockResolvedValue({
      agent: { findFirst: vi.fn().mockResolvedValue(null) },
      commandDefinition: { create },
    });

    await new CommandsService(agentControl()).importDefinition({
      payload: {
        name: "Restart",
        script: "brew services restart aide",
        targetKind: "SPECIFIC_AGENT_HOME",
        targetAgentName: "studio-mac",
        quickActionEnabled: true,
      },
    });

    // Widening made this runnable on every agent; a one-click button for that
    // is the user's call, not the importer's.
    expect(create.mock.calls[0][0].data).toMatchObject({
      targetKind: "ANY_AGENT_HOME",
      quickActionEnabled: false,
    });
  });

  test("keeps the quick action when the target resolved exactly", async () => {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "command-5", ...data }));
    getPrismaClient.mockResolvedValue({
      agent: { findFirst: vi.fn().mockResolvedValue({ id: "agent-9" }) },
      commandDefinition: { create },
    });

    await new CommandsService(agentControl()).importDefinition({
      payload: {
        name: "Restart",
        script: "brew services restart aide",
        targetKind: "SPECIFIC_AGENT_HOME",
        targetAgentName: "studio-mac",
        quickActionEnabled: true,
      },
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      targetAgentId: "agent-9",
      quickActionEnabled: true,
    });
  });

  test("orders name lookups so a duplicated name resolves deterministically", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "agent-9" });
    getPrismaClient.mockResolvedValue({
      agent: { findFirst },
      commandDefinition: {
        create: vi.fn().mockImplementation(({ data }) => ({
          id: "command-6",
          ...data,
        })),
      },
    });

    await new CommandsService(agentControl()).importDefinition({
      payload: {
        name: "Restart",
        script: "brew services restart aide",
        targetKind: "SPECIFIC_AGENT_HOME",
        targetAgentName: "studio-mac",
      },
    });

    // Agent names are not unique, so the query has to pick the same record
    // every time rather than whatever the database happens to return first.
    expect(findFirst).toHaveBeenCalledWith({
      where: { name: "studio-mac" },
      orderBy: { id: "asc" },
    });
  });

  test("parses and bounds a payload handed over as a JSON string", async () => {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "command-7", ...data }));
    getPrismaClient.mockResolvedValue({ commandDefinition: { create } });
    const service = new CommandsService(agentControl());

    await service.importDefinition({
      payload: JSON.stringify({ name: "Test", script: "npm test" }),
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ name: "Test" });

    await expect(
      service.importDefinition({ payload: "x".repeat(2 * 1024 * 1024 + 1) }),
    ).rejects.toThrow("too large");
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
