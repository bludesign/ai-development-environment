import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";

import { SkillsService } from "./skills.service";

function serviceWith(cancelJob = vi.fn()) {
  const agentControl = {
    cancelJob,
    registerCompletionHandler: vi.fn(),
    registerConnectionHandler: vi.fn(),
  } as unknown as AgentControlService;
  return { cancelJob, service: new SkillsService(agentControl) };
}

const settings = {
  id: "default",
  autoSyncProjectGroups: false,
  cursorEnabled: false,
  githubCopilotEnabled: false,
  codexEnabled: true,
  claudeEnabled: false,
  openCodeEnabled: false,
};

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: "skill-1",
    name: "swift-review",
    description: "Review Swift code safely.",
    syncGlobally: true,
    packageHash: "hash-1",
    deletedAt: null,
    files: [],
    groups: [],
    ...overrides,
  };
}

describe("SkillsService synchronization planning", () => {
  beforeEach(() => vi.clearAllMocks());

  test("uses Windows path semantics for paths reported by a Windows agent", async () => {
    const prisma = {
      skillToolObservation: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentId: "agent-1",
            tool: "CODEX",
            configured: true,
            homePath: "C:\\Users\\Ada",
          },
        ]),
      },
      skill: { findMany: vi.fn().mockResolvedValue([skill()]) },
      skillGroup: { findMany: vi.fn().mockResolvedValue([]) },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { service } = serviceWith();
    vi.spyOn(service, "settings").mockResolvedValue(settings as never);

    const desired = await (
      service as unknown as {
        desiredLocations(run: {
          kind: string;
          groupId: string | null;
        }): Promise<Array<{ rootPath: string; targetPath: string }>>;
      }
    ).desiredLocations({ kind: "ALL", groupId: null });

    expect(desired).toEqual([
      expect.objectContaining({
        rootPath: "C:\\Users\\Ada\\.agents\\skills",
        targetPath: "C:\\Users\\Ada\\.agents\\skills\\swift-review",
      }),
    ]);
  });

  test("queries only the selected group for a targeted group plan", async () => {
    const prisma = {
      skillToolObservation: { findMany: vi.fn().mockResolvedValue([]) },
      skillGroup: { findMany: vi.fn().mockResolvedValue([]) },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { service } = serviceWith();
    vi.spyOn(service, "settings").mockResolvedValue(settings as never);

    await (
      service as unknown as {
        desiredLocations(run: {
          kind: string;
          groupId: string | null;
        }): Promise<unknown[]>;
      }
    ).desiredLocations({ kind: "GROUP", groupId: "group-a" });

    expect(prisma.skillGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "group-a" } }),
    );
  });

  test("deletes disabled global and renamed managed copies", async () => {
    const disabled = skill({
      id: "skill-disabled",
      name: "disabled-global",
      syncGlobally: false,
    });
    const renamed = skill({ id: "skill-renamed", name: "new-name" });
    const installations = [
      {
        id: "install-disabled",
        skillId: "skill-disabled",
        agentId: "agent-1",
        codebaseId: null,
        worktreeId: null,
        scope: "GLOBAL",
        rootKind: "AGENTS",
        rootPath: "/Users/ada/.agents/skills",
        skillName: "disabled-global",
        packageHash: "locally-modified-hash",
        tracked: false,
        baseline: { skillId: "skill-disabled", packageHash: "hash-1" },
      },
      {
        id: "install-renamed",
        skillId: null,
        agentId: "agent-1",
        codebaseId: null,
        worktreeId: null,
        scope: "GLOBAL",
        rootKind: "AGENTS",
        rootPath: "/Users/ada/.agents/skills",
        skillName: "old-name",
        packageHash: "hash-1",
        tracked: false,
        baseline: { skillId: "skill-renamed", packageHash: "hash-1" },
      },
    ];
    const createMany = vi.fn().mockResolvedValue({ count: 3 });
    const prisma = {
      skillSyncRun: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: "run-1", kind: "ALL", groupId: null }),
      },
      skillSyncItem: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        deleteMany: vi.fn(),
        createMany,
      },
      skill: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([disabled, renamed])
          .mockResolvedValueOnce([]),
      },
      skillInstallation: { findMany: vi.fn().mockResolvedValue(installations) },
      skillSyncBaseline: { upsert: vi.fn() },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { service } = serviceWith();
    vi.spyOn(service, "settings").mockResolvedValue(settings as never);
    vi.spyOn(
      service as unknown as {
        desiredLocations(): Promise<unknown[]>;
      },
      "desiredLocations",
    ).mockResolvedValue([
      {
        skill: renamed,
        agentId: "agent-1",
        codebaseId: null,
        worktreeId: null,
        scope: "GLOBAL",
        rootKind: "AGENTS",
        folder: null,
        rootPath: "/Users/ada/.agents/skills",
        targetPath: "/Users/ada/.agents/skills/new-name",
      },
    ]);
    vi.spyOn(
      service as unknown as { refreshRunStatus(): Promise<void> },
      "refreshRunStatus",
    ).mockResolvedValue();

    await (
      service as unknown as { buildPlan(runId: string): Promise<void> }
    ).buildPlan("run-1");

    const items = createMany.mock.calls[0]![0].data as Array<{
      installationId?: string;
      skillId?: string;
      direction: string;
    }>;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installationId: "install-disabled",
          skillId: "skill-disabled",
          direction: "DELETE_MANAGED",
        }),
        expect.objectContaining({
          skillId: "skill-renamed",
          direction: "EXPORT",
        }),
        expect.objectContaining({
          installationId: "install-renamed",
          skillId: "skill-renamed",
          direction: "DELETE_MANAGED",
        }),
      ]),
    );
  });

  test("keeps copies in a selected group's repository when another group still desires them", async () => {
    const sharedSkill = skill();
    const installation = {
      id: "install-1",
      skillId: "skill-1",
      agentId: "agent-1",
      codebaseId: "codebase-1",
      worktreeId: null,
      scope: "PROJECT",
      rootKind: "AGENTS",
      rootPath: "/repo/.agents/skills",
      skillName: "swift-review",
      packageHash: "hash-1",
      tracked: false,
      baseline: { skillId: "skill-1", packageHash: "hash-1" },
    };
    const protectedTarget = {
      skill: sharedSkill,
      agentId: "agent-1",
      codebaseId: "codebase-1",
      worktreeId: null,
      scope: "PROJECT",
      rootKind: "AGENTS",
      folder: "/repo",
      rootPath: "/repo/.agents/skills",
      targetPath: "/repo/.agents/skills/swift-review",
    };
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findInstallations = vi.fn().mockResolvedValue([installation]);
    const prisma = {
      skillSyncRun: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "run-1",
          kind: "GROUP",
          groupId: "group-a",
        }),
      },
      skillSyncItem: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        deleteMany: vi.fn(),
        createMany,
      },
      skill: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([sharedSkill])
          .mockResolvedValueOnce([]),
      },
      skillInstallation: { findMany: findInstallations },
      skillSyncBaseline: { upsert: vi.fn() },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { service } = serviceWith();
    vi.spyOn(service, "settings").mockResolvedValue(settings as never);
    vi.spyOn(
      service as unknown as { desiredLocations(): Promise<unknown[]> },
      "desiredLocations",
    )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([protectedTarget]);
    vi.spyOn(
      service as unknown as { refreshRunStatus(): Promise<void> },
      "refreshRunStatus",
    ).mockResolvedValue();

    await (
      service as unknown as { buildPlan(runId: string): Promise<void> }
    ).buildPlan("run-1");

    expect(findInstallations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scope: "PROJECT",
          codebase: {
            repository: {
              skillGroups: { some: { groupId: "group-a" } },
            },
          },
        }),
      }),
    );
    expect(createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({
        installationId: "install-1",
        direction: "UNCHANGED",
      }),
    ]);
  });
});

describe("SkillsService.saveSkill", () => {
  beforeEach(() => vi.clearAllMocks());

  test("reconciles groups removed from an existing skill", async () => {
    const transaction = {
      skill: { upsert: vi.fn() },
      skillFile: { deleteMany: vi.fn(), createMany: vi.fn() },
      skillGroupSkill: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const prisma = {
      skillGroup: { count: vi.fn().mockResolvedValue(0) },
      skill: { findUnique: vi.fn().mockResolvedValue(null) },
      skillGroupSkill: {
        findMany: vi.fn().mockResolvedValue([{ groupId: "group-old" }]),
      },
      $transaction: vi.fn(async (callback) => callback(transaction)),
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { service } = serviceWith();
    const scheduleAutoSync = vi
      .spyOn(
        service as unknown as {
          scheduleAutoSync(groupIds: string[]): Promise<void>;
        },
        "scheduleAutoSync",
      )
      .mockResolvedValue();
    vi.spyOn(service, "getSkill").mockResolvedValue(skill() as never);

    await service.saveSkill({
      id: "skill-1",
      name: "swift-review",
      description: "Review Swift code safely.",
      syncGlobally: true,
      groupIds: [],
      files: [
        {
          path: "SKILL.md",
          contentsBase64: Buffer.from(
            "---\nname: swift-review\ndescription: Review Swift code safely.\n---\n",
          ).toString("base64"),
          executable: false,
        },
      ],
    });

    expect(scheduleAutoSync).toHaveBeenCalledWith(["group-old"]);
  });
});

describe("SkillsService.skipPending", () => {
  beforeEach(() => vi.clearAllMocks());

  test("skips a pending scan, cancels its job, and continues planning", async () => {
    const pendingScan = {
      id: "scan-item-1",
      runId: "run-1",
      agentId: "agent-1",
      direction: "SCAN",
      status: "PENDING",
      candidatePackageJson: null,
    };
    const persistedRun = { id: "run-1", status: "READY" };
    const prisma = {
      agentJob: {
        findUnique: vi.fn().mockResolvedValue({ id: "scan-job-1" }),
      },
      skillSyncItem: {
        findMany: vi.fn().mockResolvedValue([pendingScan]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      skillSyncRun: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(persistedRun),
        findUnique: vi.fn().mockResolvedValue(persistedRun),
      },
      skillDeployment: { updateMany: vi.fn() },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { cancelJob, service } = serviceWith();
    const buildPlan = vi
      .spyOn(
        service as unknown as { buildPlan(runId: string): Promise<void> },
        "buildPlan",
      )
      .mockResolvedValue();

    await expect(service.skipPending("run-1")).resolves.toBe(persistedRun);

    expect(prisma.skillSyncItem.updateMany).toHaveBeenCalledWith({
      where: { id: "scan-item-1", status: "PENDING" },
      data: { status: "SKIPPED", resolution: "SKIP" },
    });
    expect(prisma.agentJob.findUnique).toHaveBeenCalledWith({
      where: {
        agentId_idempotencyKey: {
          agentId: "agent-1",
          idempotencyKey: "skills:scan:run-1:agent-1",
        },
      },
    });
    expect(cancelJob).toHaveBeenCalledWith("scan-job-1");
    expect(buildPlan).toHaveBeenCalledWith("run-1");
  });

  test("marks a sync partial when its last pending apply is skipped", async () => {
    const pendingApply = {
      id: "apply-item-1",
      runId: "run-1",
      agentId: "agent-1",
      direction: "APPLY",
      status: "PENDING",
      candidatePackageJson: JSON.stringify({
        deployments: [{ id: "deployment-1" }],
      }),
    };
    const persistedRun = { id: "run-1", status: "PARTIAL" };
    const prisma = {
      agentJob: {
        findUnique: vi.fn().mockResolvedValue({ id: "apply-job-1" }),
      },
      skillSyncItem: {
        findMany: vi.fn().mockResolvedValue([pendingApply]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      skillSyncRun: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(persistedRun),
        findUnique: vi.fn().mockResolvedValue(persistedRun),
        update: vi.fn().mockResolvedValue(persistedRun),
      },
      skillDeployment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { cancelJob, service } = serviceWith();

    await expect(service.skipPending("run-1")).resolves.toBe(persistedRun);

    expect(cancelJob).toHaveBeenCalledWith("apply-job-1");
    expect(prisma.skillDeployment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["deployment-1"] }, status: "PENDING" },
      data: { status: "SKIPPED" },
    });
    expect(prisma.skillSyncRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { status: "PARTIAL", finishedAt: expect.any(Date) },
    });
  });
});

describe("SkillsService.resolveItem", () => {
  beforeEach(() => vi.clearAllMocks());

  test("turns a client import into a planned deletion", async () => {
    const item = {
      id: "import-item-1",
      runId: "run-1",
      installationId: "installation-1",
      direction: "IMPORT",
      status: "BLOCKED",
      candidatePackageJson: JSON.stringify({
        projectGroupRequired: true,
        package: { name: "swift-review" },
      }),
    };
    const persistedRun = { id: "run-1", status: "READY" };
    const prisma = {
      skillSyncItem: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(item),
        update: vi.fn().mockResolvedValue({
          ...item,
          direction: "DELETE_REDUNDANT",
          resolution: "DELETE",
          status: "READY",
        }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { service } = serviceWith();
    vi.spyOn(
      service as unknown as { refreshRunStatus(runId: string): Promise<void> },
      "refreshRunStatus",
    ).mockResolvedValue();
    vi.spyOn(service, "getRun").mockResolvedValue(persistedRun as never);

    await expect(
      service.resolveItem({
        itemId: "import-item-1",
        resolution: "DELETE",
      }),
    ).resolves.toBe(persistedRun);

    expect(prisma.skillSyncItem.update).toHaveBeenCalledWith({
      where: { id: "import-item-1" },
      data: {
        resolution: "DELETE",
        direction: "DELETE_REDUNDANT",
        candidatePackageJson: item.candidatePackageJson,
        status: "READY",
      },
    });
  });
});
