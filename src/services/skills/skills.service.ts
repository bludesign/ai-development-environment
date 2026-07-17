import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import {
  AI_TOOLS,
  SKILL_APPLY_JOB_KIND,
  SKILL_READ_JOB_KIND,
  SKILL_SCAN_JOB_KIND,
  hashSkillFiles,
  parseSkillPackage,
  type AiTool,
  type SkillLocation,
  type SkillPackage,
  type SkillPackageFile,
  type SkillRootKind,
  type SkillScanResult,
  type SkillScanTarget,
} from "@ai-development-environment/agent-contract/skills";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  AgentControlService,
  SKILLS_CHANGED_TOPIC,
  agentEventBus,
  skillSyncRunTopic,
} from "@/services/agent-control";
import {
  compareSkillVersions,
  hasDivergentTargetVersions,
  selectSharedSkillRoots,
} from "./sync-direction";

const SETTINGS_ID = "default";
const ACTIVE_RUN_STATUSES = [
  "PREPARING",
  "READY",
  "APPLYING",
  "NEEDS_RESOLUTION",
];

const skillInclude = {
  files: { orderBy: { path: "asc" as const } },
  groups: { include: { group: true } },
} as const;

const groupInclude = {
  skills: { include: { skill: { include: { files: true } } } },
  repositories: { include: { repository: true } },
} as const;

type SkillRecord = Prisma.SkillGetPayload<{ include: typeof skillInclude }>;
type SkillInput = {
  id?: string | null;
  name: string;
  description: string;
  syncGlobally: boolean;
  groupIds: string[];
  files: Array<{ path: string; contentsBase64: string; executable: boolean }>;
};
type CompletionJob = {
  id: string;
  agentId: string;
  kind: string;
  payloadJson: string;
  status: string;
  resultJson: string | null;
  error: string | null;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function packageInput(input: SkillInput): SkillPackage {
  const files: SkillPackageFile[] = input.files.map((file) => ({
    path: file.path,
    contentsBase64: file.contentsBase64,
    executable: file.executable,
  }));
  return parseSkillPackage({
    name: input.name,
    description: input.description,
    packageHash: hashSkillFiles(files),
    files,
  });
}

function skillPackage(skill: SkillRecord): SkillPackage {
  const files = skill.files.map((file) => ({
    path: file.path,
    contentsBase64: Buffer.from(file.contents).toString("base64"),
    executable: file.executable,
  }));
  return {
    name: skill.name,
    description: skill.description,
    packageHash: skill.packageHash,
    files,
  };
}

function contentHash(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function enabledTools(settings: {
  cursorEnabled: boolean;
  githubCopilotEnabled: boolean;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  openCodeEnabled: boolean;
}): AiTool[] {
  return [
    ...(settings.cursorEnabled ? (["CURSOR"] as const) : []),
    ...(settings.githubCopilotEnabled ? (["GITHUB_COPILOT"] as const) : []),
    ...(settings.codexEnabled ? (["CODEX"] as const) : []),
    ...(settings.claudeEnabled ? (["CLAUDE"] as const) : []),
    ...(settings.openCodeEnabled ? (["OPENCODE"] as const) : []),
  ];
}

function rootParts(
  scope: "GLOBAL" | "PROJECT",
  rootKind: SkillRootKind,
): string[] {
  if (rootKind === "AGENTS") return [".agents", "skills"];
  if (rootKind === "CLAUDE") return [".claude", "skills"];
  if (scope === "GLOBAL") {
    if (rootKind === "CURSOR") return [".cursor", "skills"];
    if (rootKind === "GITHUB_COPILOT") return [".copilot", "skills"];
    if (rootKind === "CODEX_LEGACY") return [".codex", "skills"];
    return [".config", "opencode", "skills"];
  }
  if (rootKind === "CURSOR") return [".cursor", "skills"];
  if (rootKind === "GITHUB_COPILOT") return [".github", "skills"];
  if (rootKind === "CODEX_LEGACY") return [".codex", "skills"];
  return [".opencode", "skills"];
}

export class SkillsService {
  constructor(private readonly agentControl: AgentControlService) {
    this.agentControl.registerCompletionHandler(SKILL_SCAN_JOB_KIND, (job) =>
      this.completeScan(job),
    );
    this.agentControl.registerCompletionHandler(SKILL_READ_JOB_KIND, (job) =>
      this.completeRead(job),
    );
    this.agentControl.registerCompletionHandler(SKILL_APPLY_JOB_KIND, (job) =>
      this.completeApply(job),
    );
    this.agentControl.registerConnectionHandler(async () => {
      await this.requestAutoReconcile();
    });
  }

  private publish(runId?: string): void {
    agentEventBus.publish(SKILLS_CHANGED_TOPIC, { id: runId ?? null });
    if (runId) {
      agentEventBus.publish(skillSyncRunTopic(runId), { id: runId });
    }
  }

  subscribe() {
    return agentEventBus.iterate<{ id: string | null }>(SKILLS_CHANGED_TOPIC);
  }

  subscribeRun(runId: string) {
    return agentEventBus.iterate<{ id: string }>(skillSyncRunTopic(runId));
  }

  async settings() {
    const prisma = await getPrismaClient();
    return prisma.skillSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }

  async overview(searchValue = "") {
    const prisma = await getPrismaClient();
    const search = searchValue.trim().toLocaleLowerCase();
    const [
      skills,
      groups,
      observations,
      installations,
      settings,
      repositories,
    ] = await Promise.all([
      prisma.skill.findMany({
        where: { deletedAt: null },
        include: skillInclude,
        orderBy: { name: "asc" },
      }),
      prisma.skillGroup.findMany({
        include: groupInclude,
        orderBy: { name: "asc" },
      }),
      prisma.skillToolObservation.findMany({
        include: { agent: true },
        orderBy: [{ tool: "asc" }, { agent: { name: "asc" } }],
      }),
      prisma.skillInstallation.findMany({
        where: { present: true },
        include: {
          agent: true,
          codebase: { include: { repository: true } },
          worktree: true,
          baseline: true,
          skill: true,
        },
        orderBy: [{ skillName: "asc" }, { rootPath: "asc" }],
      }),
      this.settings(),
      prisma.codebaseRepository.findMany({ orderBy: { name: "asc" } }),
    ]);
    const filteredSkills = search
      ? skills.filter((skill) =>
          [
            skill.name,
            skill.description,
            ...skill.groups.map(({ group }) => group.name),
          ].some((value) => value.toLocaleLowerCase().includes(search)),
        )
      : skills;
    const filteredInstallations = search
      ? installations.filter((installation) =>
          [
            installation.skillName,
            installation.description,
            installation.agent.name,
            installation.rootPath,
            installation.codebase?.repository.name ?? "",
          ].some((value) => value.toLocaleLowerCase().includes(search)),
        )
      : installations;
    return {
      skills: filteredSkills,
      groups,
      observations,
      installations: filteredInstallations,
      settings,
      repositories,
    };
  }

  async getSkill(id: string) {
    const prisma = await getPrismaClient();
    return prisma.skill.findFirst({
      where: { id, deletedAt: null },
      include: skillInclude,
    });
  }

  async saveSkill(input: SkillInput) {
    const value = packageInput(input);
    const uniqueGroups = [...new Set(input.groupIds)].slice(0, 100);
    const prisma = await getPrismaClient();
    const groups = await prisma.skillGroup.count({
      where: { id: { in: uniqueGroups } },
    });
    if (groups !== uniqueGroups.length)
      throw new Error("One or more skill groups were not found");
    const existingByName = await prisma.skill.findUnique({
      where: { name: value.name },
    });
    if (existingByName && existingByName.id !== input.id) {
      throw new Error("Skill names must be unique");
    }
    const skillId = input.id ?? randomUUID();
    await prisma.$transaction(async (transaction) => {
      await transaction.skill.upsert({
        where: { id: skillId },
        create: {
          id: skillId,
          name: value.name,
          description: value.description,
          syncGlobally: input.syncGlobally,
          packageHash: value.packageHash,
        },
        update: {
          name: value.name,
          description: value.description,
          syncGlobally: input.syncGlobally,
          packageHash: value.packageHash,
          deletedAt: null,
        },
      });
      await transaction.skillFile.deleteMany({ where: { skillId } });
      await transaction.skillFile.createMany({
        data: value.files.map((file) => {
          const contents = Buffer.from(file.contentsBase64, "base64");
          return {
            id: randomUUID(),
            skillId,
            path: file.path,
            contents,
            executable: file.executable,
            contentHash: contentHash(contents),
          };
        }),
      });
      await transaction.skillGroupSkill.deleteMany({ where: { skillId } });
      if (uniqueGroups.length) {
        await transaction.skillGroupSkill.createMany({
          data: uniqueGroups.map((groupId) => ({ groupId, skillId })),
        });
      }
    });
    this.publish();
    await this.scheduleAutoSync(uniqueGroups);
    return (await this.getSkill(skillId))!;
  }

  async deleteSkill(id: string) {
    const prisma = await getPrismaClient();
    const skill = await prisma.skill.findUnique({
      where: { id },
      include: { groups: true },
    });
    if (!skill) return false;
    await prisma.skill.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    this.publish();
    await this.scheduleAutoSync(skill.groups.map((group) => group.groupId));
    return true;
  }

  async saveGroup(input: {
    id?: string | null;
    name: string;
    skillIds: string[];
    repositoryIds: string[];
  }) {
    const name = input.name.trim();
    if (!name || name.length > 80)
      throw new Error("Group names must contain 1-80 characters");
    const skillIds = [...new Set(input.skillIds)].slice(0, 500);
    const repositoryIds = [...new Set(input.repositoryIds)].slice(0, 500);
    const prisma = await getPrismaClient();
    const [skillCount, repositoryCount, duplicate] = await Promise.all([
      prisma.skill.count({ where: { id: { in: skillIds }, deletedAt: null } }),
      prisma.codebaseRepository.count({ where: { id: { in: repositoryIds } } }),
      prisma.skillGroup.findUnique({ where: { name } }),
    ]);
    if (skillCount !== skillIds.length)
      throw new Error("One or more skills were not found");
    if (repositoryCount !== repositoryIds.length) {
      throw new Error("One or more repositories were not found");
    }
    if (duplicate && duplicate.id !== input.id)
      throw new Error("Group names must be unique");
    const id = input.id ?? randomUUID();
    await prisma.$transaction(async (transaction) => {
      await transaction.skillGroup.upsert({
        where: { id },
        create: { id, name },
        update: { name },
      });
      await transaction.skillGroupSkill.deleteMany({ where: { groupId: id } });
      await transaction.codebaseRepositorySkillGroup.deleteMany({
        where: { groupId: id },
      });
      if (skillIds.length) {
        await transaction.skillGroupSkill.createMany({
          data: skillIds.map((skillId) => ({ groupId: id, skillId })),
        });
      }
      if (repositoryIds.length) {
        await transaction.codebaseRepositorySkillGroup.createMany({
          data: repositoryIds.map((repositoryId) => ({
            groupId: id,
            repositoryId,
          })),
        });
      }
    });
    this.publish();
    await this.scheduleAutoSync([id]);
    return prisma.skillGroup.findUniqueOrThrow({
      where: { id },
      include: groupInclude,
    });
  }

  async validateGroupIds(groupIds: string[]) {
    const unique = [...new Set(groupIds)].slice(0, 100);
    const prisma = await getPrismaClient();
    if (
      (await prisma.skillGroup.count({ where: { id: { in: unique } } })) !==
      unique.length
    ) {
      throw new Error("One or more skill groups were not found");
    }
    return unique;
  }

  async groupsForRepository(repositoryId: string) {
    const prisma = await getPrismaClient();
    const assignments = await prisma.codebaseRepositorySkillGroup.findMany({
      where: { repositoryId },
      include: { group: true },
      orderBy: { group: { name: "asc" } },
    });
    return assignments.map((assignment) => assignment.group);
  }

  async deleteGroup(id: string) {
    const prisma = await getPrismaClient();
    const deleted = await prisma.skillGroup.deleteMany({ where: { id } });
    if (deleted.count) this.publish();
    if (deleted.count && (await this.settings()).autoSyncProjectGroups) {
      await this.prepareSync("GROUP", null, true);
    }
    return deleted.count > 0;
  }

  async saveSettings(input: {
    autoSyncProjectGroups: boolean;
    cursorEnabled: boolean;
    githubCopilotEnabled: boolean;
    codexEnabled: boolean;
    claudeEnabled: boolean;
    openCodeEnabled: boolean;
  }) {
    const prisma = await getPrismaClient();
    const settings = await prisma.skillSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...input },
      update: input,
    });
    this.publish();
    if (settings.autoSyncProjectGroups)
      await this.prepareSync("GROUP", null, true);
    return settings;
  }

  async setRepositoryGroups(repositoryId: string, groupIds: string[]) {
    const unique = await this.validateGroupIds(groupIds);
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      await transaction.codebaseRepositorySkillGroup.deleteMany({
        where: { repositoryId },
      });
      if (unique.length) {
        await transaction.codebaseRepositorySkillGroup.createMany({
          data: unique.map((groupId) => ({ repositoryId, groupId })),
        });
      }
    });
    this.publish();
    if ((await this.settings()).autoSyncProjectGroups) {
      await this.prepareSync("GROUP", null, true);
    }
  }

  private async scheduleAutoSync(groupIds: string[]) {
    const settings = await this.settings();
    if (!settings.autoSyncProjectGroups || !groupIds.length) return;
    for (const groupId of [...new Set(groupIds)]) {
      await this.prepareSync("GROUP", groupId, true);
    }
  }

  async requestAutoReconcile() {
    if (!(await this.settings()).autoSyncProjectGroups) return null;
    return this.prepareSync("GROUP", null, true);
  }

  private async targets(agentId: string): Promise<SkillScanTarget[]> {
    const prisma = await getPrismaClient();
    const codebases = await prisma.codebase.findMany({
      where: { agentId, availability: "AVAILABLE" },
      include: { worktrees: { where: { missingAt: null } } },
    });
    const targets = new Map<string, SkillScanTarget>();
    for (const codebase of codebases) {
      targets.set(codebase.folder, {
        codebaseId: codebase.id,
        worktreeId: null,
        folder: codebase.folder,
      });
      for (const worktree of codebase.worktrees) {
        targets.set(worktree.folder, {
          codebaseId: codebase.id,
          worktreeId: worktree.id,
          folder: worktree.folder,
        });
      }
    }
    return [...targets.values()];
  }

  async prepareSync(
    kind: "ALL" | "GROUP",
    groupId?: string | null,
    automatic = false,
  ) {
    const prisma = await getPrismaClient();
    if (
      groupId &&
      !(await prisma.skillGroup.findUnique({ where: { id: groupId } }))
    ) {
      throw new Error("Skill group not found");
    }
    if (automatic) {
      const existing = await prisma.skillSyncRun.findFirst({
        where: {
          kind,
          groupId: groupId ?? null,
          status: { in: ACTIVE_RUN_STATUSES },
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) return existing;
    }
    const run = await prisma.skillSyncRun.create({
      data: {
        id: randomUUID(),
        kind,
        groupId: groupId ?? null,
        automatic,
        status: "PREPARING",
      },
    });
    const settings = await this.settings();
    const tools = enabledTools(settings);
    const agents = await prisma.agent.findMany({ orderBy: { name: "asc" } });
    for (const agent of agents) {
      const item = await prisma.skillSyncItem.create({
        data: {
          id: randomUUID(),
          runId: run.id,
          agentId: agent.id,
          direction: "SCAN",
          status: "PENDING",
        },
      });
      await this.agentControl.createJob({
        agentId: agent.id,
        kind: SKILL_SCAN_JOB_KIND,
        payload: {
          tools,
          targets: await this.targets(agent.id),
          syncRunId: run.id,
          syncItemId: item.id,
        },
        idempotencyKey: `skills:scan:${run.id}:${agent.id}`,
        timeoutSeconds: 300,
        visibility: automatic ? "SYSTEM" : "USER",
      });
    }
    if (!agents.length) {
      await prisma.skillSyncRun.update({
        where: { id: run.id },
        data: { status: "READY" },
      });
      if (automatic) return this.applyRun(run.id);
    }
    this.publish(run.id);
    return this.getRun(run.id);
  }

  async getRun(id: string) {
    const prisma = await getPrismaClient();
    return prisma.skillSyncRun.findUnique({
      where: { id },
      include: {
        group: true,
        items: {
          include: {
            skill: true,
            installation: { include: { agent: true } },
            agent: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  }

  private completionIds(job: CompletionJob) {
    return parseJson<{ syncRunId?: string; syncItemId?: string }>(
      job.payloadJson,
      {},
    );
  }

  private async completeScan(job: CompletionJob) {
    const { syncRunId, syncItemId } = this.completionIds(job);
    if (!syncRunId || !syncItemId) return;
    const prisma = await getPrismaClient();
    if (job.status !== "SUCCEEDED" || !job.resultJson) {
      await prisma.skillSyncItem.updateMany({
        where: { id: syncItemId },
        data: { status: "FAILED", error: job.error ?? "Skill scan failed" },
      });
    } else {
      const result = parseJson<SkillScanResult & { warnings?: string[] }>(
        job.resultJson,
        {
          configuredTools: [],
          installations: [],
          warnings: [],
        },
      );
      const observedAt = new Date();
      await prisma.$transaction(async (transaction) => {
        await transaction.skillInstallation.updateMany({
          where: { agentId: job.agentId },
          data: { present: false },
        });
        for (const observation of result.configuredTools) {
          if (!AI_TOOLS.includes(observation.tool)) continue;
          await transaction.skillToolObservation.upsert({
            where: {
              agentId_tool: { agentId: job.agentId, tool: observation.tool },
            },
            create: {
              agentId: job.agentId,
              tool: observation.tool,
              configured: observation.configured,
              homePath: observation.homePath,
              checkedAt: observedAt,
            },
            update: {
              configured: observation.configured,
              homePath: observation.homePath,
              checkedAt: observedAt,
            },
          });
        }
        for (const installation of result.installations) {
          const skill = await transaction.skill.findUnique({
            where: { name: installation.skillName },
            select: { id: true, deletedAt: true },
          });
          await transaction.skillInstallation.upsert({
            where: {
              agentId_rootPath_skillName: {
                agentId: job.agentId,
                rootPath: installation.rootPath,
                skillName: installation.skillName,
              },
            },
            create: {
              id: randomUUID(),
              agentId: job.agentId,
              skillId: skill && !skill.deletedAt ? skill.id : null,
              codebaseId: installation.codebaseId,
              worktreeId: installation.worktreeId,
              scope: installation.scope,
              rootKind: installation.rootKind,
              rootPath: installation.rootPath,
              skillName: installation.skillName,
              description: installation.description,
              packageHash: installation.packageHash,
              present: true,
              fileCount: installation.fileCount,
              totalBytes: installation.totalBytes,
              tracked: installation.tracked,
              consumersJson: JSON.stringify(installation.consumers),
              lastSeenAt: observedAt,
            },
            update: {
              skillId: skill && !skill.deletedAt ? skill.id : null,
              codebaseId: installation.codebaseId,
              worktreeId: installation.worktreeId,
              scope: installation.scope,
              rootKind: installation.rootKind,
              description: installation.description,
              packageHash: installation.packageHash,
              present: true,
              fileCount: installation.fileCount,
              totalBytes: installation.totalBytes,
              tracked: installation.tracked,
              consumersJson: JSON.stringify(installation.consumers),
              lastSeenAt: observedAt,
            },
          });
        }
        await transaction.skillSyncItem.update({
          where: { id: syncItemId },
          data: {
            status: "COMPLETE",
            error: result.warnings?.length
              ? result.warnings.join("\n").slice(0, 64_000)
              : null,
          },
        });
      });
    }
    const pending = await prisma.skillSyncItem.count({
      where: { runId: syncRunId, direction: "SCAN", status: "PENDING" },
    });
    if (!pending) await this.buildPlan(syncRunId);
    this.publish(syncRunId);
  }

  private async configuredByAgent() {
    const prisma = await getPrismaClient();
    const settings = await this.settings();
    const enabled = new Set(enabledTools(settings));
    const observations = await prisma.skillToolObservation.findMany({
      where: { configured: true },
    });
    const byAgent = new Map<string, AiTool[]>();
    for (const observation of observations) {
      if (!enabled.has(observation.tool as AiTool)) continue;
      const values = byAgent.get(observation.agentId) ?? [];
      values.push(observation.tool as AiTool);
      byAgent.set(observation.agentId, values);
    }
    return byAgent;
  }

  private async desiredLocations(run: {
    kind: string;
    groupId: string | null;
  }) {
    const prisma = await getPrismaClient();
    const configured = await this.configuredByAgent();
    const observations = await prisma.skillToolObservation.findMany({
      where: { configured: true },
    });
    const homeByAgent = new Map<string, string>();
    for (const observation of observations)
      homeByAgent.set(observation.agentId, observation.homePath);
    const desired: Array<{
      skill: SkillRecord;
      agentId: string;
      codebaseId: string | null;
      worktreeId: string | null;
      scope: "GLOBAL" | "PROJECT";
      rootKind: SkillRootKind;
      folder: string | null;
      rootPath: string;
      targetPath: string;
    }> = [];
    if (run.kind === "ALL") {
      const skills = await prisma.skill.findMany({
        where: { deletedAt: null, syncGlobally: true },
        include: skillInclude,
      });
      for (const [agentId, tools] of configured) {
        const home = homeByAgent.get(agentId);
        if (!home) continue;
        for (const rootKind of selectSharedSkillRoots(tools, "GLOBAL")) {
          const rootPath = join(home, ...rootParts("GLOBAL", rootKind));
          for (const skill of skills) {
            desired.push({
              skill,
              agentId,
              codebaseId: null,
              worktreeId: null,
              scope: "GLOBAL",
              rootKind,
              folder: null,
              rootPath,
              targetPath: join(rootPath, skill.name),
            });
          }
        }
      }
    }
    const groups = await prisma.skillGroup.findMany({
      include: {
        skills: {
          where: { skill: { deletedAt: null } },
          include: { skill: { include: skillInclude } },
        },
        repositories: {
          include: {
            repository: {
              include: {
                codebases: {
                  where: { availability: "AVAILABLE" },
                  include: { worktrees: { where: { missingAt: null } } },
                },
              },
            },
          },
        },
      },
    });
    for (const group of groups) {
      for (const assignment of group.repositories) {
        for (const codebase of assignment.repository.codebases) {
          const tools = configured.get(codebase.agentId) ?? [];
          const roots = selectSharedSkillRoots(tools, "PROJECT");
          const targets = [
            { folder: codebase.folder, worktreeId: null as string | null },
            ...codebase.worktrees.map((worktree) => ({
              folder: worktree.folder,
              worktreeId: worktree.id,
            })),
          ];
          for (const target of targets) {
            for (const rootKind of roots) {
              const rootPath = join(
                target.folder,
                ...rootParts("PROJECT", rootKind),
              );
              for (const membership of group.skills) {
                desired.push({
                  skill: membership.skill,
                  agentId: codebase.agentId,
                  codebaseId: codebase.id,
                  worktreeId: target.worktreeId,
                  scope: "PROJECT",
                  rootKind,
                  folder: target.folder,
                  rootPath,
                  targetPath: join(rootPath, membership.skill.name),
                });
              }
            }
          }
        }
      }
    }
    return [
      ...new Map(
        desired.map((item) => [`${item.agentId}\0${item.targetPath}`, item]),
      ).values(),
    ];
  }

  private async buildPlan(runId: string) {
    const prisma = await getPrismaClient();
    const run = await prisma.skillSyncRun.findUniqueOrThrow({
      where: { id: runId },
    });
    await prisma.skillSyncItem.deleteMany({
      where: { runId, direction: { not: "SCAN" } },
    });
    const [skills, deletedSkills, installations, desired] = await Promise.all([
      prisma.skill.findMany({
        where: { deletedAt: null },
        include: skillInclude,
      }),
      prisma.skill.findMany({ where: { deletedAt: { not: null } } }),
      prisma.skillInstallation.findMany({
        where: {
          present: true,
          ...(run.kind === "GROUP" ? { scope: "PROJECT" } : {}),
        },
        include: { baseline: true },
      }),
      this.desiredLocations(run),
    ]);
    const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
    const deletedByName = new Map(
      deletedSkills.map((skill) => [skill.name, skill]),
    );
    const targetHashesByName = new Map<string, string[]>();
    for (const installation of installations) {
      const hashes = targetHashesByName.get(installation.skillName) ?? [];
      hashes.push(installation.packageHash);
      targetHashesByName.set(installation.skillName, hashes);
    }
    const divergentTargetNames = new Set(
      [...targetHashesByName].flatMap(([name, targetHashes]) =>
        hasDivergentTargetVersions(
          skillsByName.get(name)?.packageHash ?? null,
          targetHashes,
        )
          ? [name]
          : [],
      ),
    );
    const createItems: Prisma.SkillSyncItemCreateManyInput[] = [];
    for (const target of desired) {
      const current = installations.find(
        (installation) =>
          installation.agentId === target.agentId &&
          installation.rootPath === target.rootPath &&
          installation.skillName === target.skill.name,
      );
      if (!current) {
        createItems.push({
          id: randomUUID(),
          runId,
          skillId: target.skill.id,
          agentId: target.agentId,
          direction: "EXPORT",
          status: "READY",
          sourceHash: target.skill.packageHash,
          candidatePackageJson: JSON.stringify({ location: target }),
        });
      }
    }
    for (const installation of installations) {
      const skill = skillsByName.get(installation.skillName);
      const deletedSkill = deletedByName.get(installation.skillName);
      const desiredForInstallation = desired.find(
        (target) =>
          target.agentId === installation.agentId &&
          target.rootPath === installation.rootPath &&
          target.skill.name === installation.skillName,
      );
      if (
        skill &&
        installation.packageHash === skill.packageHash &&
        !installation.baseline
      ) {
        await prisma.skillSyncBaseline.upsert({
          where: { installationId: installation.id },
          create: {
            id: randomUUID(),
            installationId: installation.id,
            skillId: skill.id,
            packageHash: skill.packageHash,
          },
          update: {
            skillId: skill.id,
            packageHash: skill.packageHash,
            syncedAt: new Date(),
          },
        });
      }
      let direction = "UNCHANGED";
      let status = "COMPLETE";
      if (deletedSkill && installation.baseline && !installation.tracked) {
        direction = "DELETE_MANAGED";
        status = "READY";
      } else if (!skill) {
        direction = divergentTargetNames.has(installation.skillName)
          ? "CONFLICT"
          : "IMPORT";
        status =
          direction === "CONFLICT" || installation.scope === "PROJECT"
            ? "BLOCKED"
            : "READY";
      } else if (installation.packageHash !== skill.packageHash) {
        direction = divergentTargetNames.has(installation.skillName)
          ? "CONFLICT"
          : compareSkillVersions({
              databaseHash: skill.packageHash,
              targetHash: installation.packageHash,
              baselineHash: installation.baseline?.packageHash ?? null,
              tracked: installation.tracked,
            });
        status = direction === "CONFLICT" ? "BLOCKED" : "READY";
      } else if (
        !desiredForInstallation &&
        installation.scope === "PROJECT" &&
        installation.baseline &&
        !installation.tracked
      ) {
        direction = "DELETE_MANAGED";
        status = "READY";
      } else if (
        !desiredForInstallation &&
        ["CURSOR", "GITHUB_COPILOT", "CODEX_LEGACY", "OPENCODE"].includes(
          installation.rootKind,
        )
      ) {
        const canonicalExists = desired.some(
          (target) =>
            target.agentId === installation.agentId &&
            target.scope === installation.scope &&
            target.skill.name === installation.skillName &&
            target.skill.packageHash === installation.packageHash,
        );
        if (canonicalExists && !installation.tracked) {
          direction = "DELETE_REDUNDANT";
          status = "READY";
        }
      }
      createItems.push({
        id: randomUUID(),
        runId,
        skillId: skill?.id ?? deletedSkill?.id ?? null,
        installationId: installation.id,
        agentId: installation.agentId,
        direction,
        status,
        sourceHash: skill?.packageHash ?? null,
        targetHash: installation.packageHash,
        candidatePackageJson: JSON.stringify({
          location: {
            scope: installation.scope,
            rootKind: installation.rootKind,
            folder:
              installation.scope === "PROJECT"
                ? (desiredForInstallation?.folder ?? null)
                : null,
            skillName: installation.skillName,
          },
          projectGroupRequired: !skill && installation.scope === "PROJECT",
        }),
      });
    }
    if (createItems.length)
      await prisma.skillSyncItem.createMany({ data: createItems });
    const readable = await prisma.skillSyncItem.findMany({
      where: {
        runId,
        installationId: { not: null },
        direction: { in: ["IMPORT", "CONFLICT"] },
      },
      include: { installation: true },
    });
    const byAgent = new Map<string, typeof readable>();
    for (const item of readable) {
      if (!item.agentId || !item.installation) continue;
      const values = byAgent.get(item.agentId) ?? [];
      values.push(item);
      byAgent.set(item.agentId, values);
    }
    const settings = await this.settings();
    const tools = enabledTools(settings);
    for (const [agentId, items] of byAgent) {
      const readItem = await prisma.skillSyncItem.create({
        data: {
          id: randomUUID(),
          runId,
          agentId,
          direction: "READ",
          status: "PENDING",
        },
      });
      const targets = await this.targets(agentId);
      await this.agentControl.createJob({
        agentId,
        kind: SKILL_READ_JOB_KIND,
        payload: {
          tools,
          targets,
          requests: items.map((item) => ({
            scope: item.installation!.scope,
            rootKind: item.installation!.rootKind,
            folder:
              item.installation!.scope === "PROJECT"
                ? (targets.find(
                    (target) =>
                      target.codebaseId === item.installation!.codebaseId &&
                      target.worktreeId === item.installation!.worktreeId,
                  )?.folder ?? null)
                : null,
            skillName: item.installation!.skillName,
          })),
          syncRunId: runId,
          syncItemId: readItem.id,
        },
        idempotencyKey: `skills:read:${runId}:${agentId}`,
        timeoutSeconds: 300,
      });
    }
    await this.refreshRunStatus(runId);
  }

  private async completeRead(job: CompletionJob) {
    const { syncRunId, syncItemId } = this.completionIds(job);
    if (!syncRunId || !syncItemId) return;
    const prisma = await getPrismaClient();
    if (job.status !== "SUCCEEDED" || !job.resultJson) {
      await prisma.skillSyncItem.update({
        where: { id: syncItemId },
        data: {
          status: "FAILED",
          error: job.error ?? "Skill package read failed",
        },
      });
    } else {
      const result = parseJson<{
        packages: Array<SkillLocation & { package: SkillPackage }>;
      }>(job.resultJson, { packages: [] });
      const items = await prisma.skillSyncItem.findMany({
        where: {
          runId: syncRunId,
          agentId: job.agentId,
          installationId: { not: null },
          direction: { in: ["IMPORT", "CONFLICT"] },
        },
        include: { installation: true },
      });
      for (const candidate of result.packages) {
        const item = items.find(
          (value) =>
            value.installation?.skillName === candidate.package.name &&
            value.installation?.rootKind === candidate.rootKind &&
            value.installation?.scope === candidate.scope &&
            (candidate.scope === "GLOBAL" ||
              value.installation?.rootPath ===
                join(
                  candidate.folder!,
                  ...rootParts("PROJECT", candidate.rootKind),
                )),
        );
        if (!item) continue;
        const previous = parseJson<Record<string, unknown>>(
          item.candidatePackageJson,
          {},
        );
        await prisma.skillSyncItem.update({
          where: { id: item.id },
          data: {
            candidatePackageJson: JSON.stringify({
              ...previous,
              package: candidate.package,
            }),
          },
        });
      }
      await prisma.skillSyncItem.update({
        where: { id: syncItemId },
        data: { status: "COMPLETE" },
      });
    }
    await this.refreshRunStatus(syncRunId);
    this.publish(syncRunId);
  }

  private async refreshRunStatus(runId: string) {
    const prisma = await getPrismaClient();
    const items = await prisma.skillSyncItem.findMany({ where: { runId } });
    const pendingPreparation = items.some(
      (item) =>
        ["SCAN", "READ"].includes(item.direction) && item.status === "PENDING",
    );
    if (pendingPreparation) return;
    const blocked = items.some((item) => item.status === "BLOCKED");
    const failed = items.some((item) => item.status === "FAILED");
    const status = blocked ? "NEEDS_RESOLUTION" : failed ? "PARTIAL" : "READY";
    const run = await prisma.skillSyncRun.update({
      where: { id: runId },
      data: { status },
    });
    this.publish(runId);
    if (run.automatic && status === "READY") await this.applyRun(runId);
  }

  async resolveItem(input: {
    itemId: string;
    resolution: "DATABASE" | "TARGET" | "MANUAL" | "SKIP";
    groupId?: string | null;
    package?: SkillPackage | null;
  }) {
    const prisma = await getPrismaClient();
    const item = await prisma.skillSyncItem.findUniqueOrThrow({
      where: { id: input.itemId },
    });
    if (!["BLOCKED", "READY"].includes(item.status))
      throw new Error("Sync item cannot be resolved");
    const candidate = parseJson<Record<string, unknown>>(
      item.candidatePackageJson,
      {},
    );
    if (input.resolution === "MANUAL") {
      candidate.package = parseSkillPackage(
        input.package,
        "manual resolution package",
      );
    }
    if (input.resolution === "TARGET" && !candidate.package) {
      throw new Error("The target package is unavailable");
    }
    if (candidate.projectGroupRequired) {
      if (
        !input.groupId ||
        !(await prisma.skillGroup.findUnique({ where: { id: input.groupId } }))
      ) {
        throw new Error("A project skill import requires a skill group");
      }
      candidate.groupId = input.groupId;
    }
    await prisma.skillSyncItem.update({
      where: { id: item.id },
      data: {
        resolution: input.resolution,
        candidatePackageJson: JSON.stringify(candidate),
        status: input.resolution === "SKIP" ? "SKIPPED" : "READY",
      },
    });
    if (["TARGET", "MANUAL"].includes(input.resolution)) {
      const selectedName =
        (candidate.package as SkillPackage | undefined)?.name ?? null;
      if (selectedName) {
        const peers = await prisma.skillSyncItem.findMany({
          where: {
            runId: item.runId,
            id: { not: item.id },
            direction: "CONFLICT",
            status: { in: ["BLOCKED", "READY"] },
          },
          include: { skill: true, installation: true },
        });
        const peerIds = peers.flatMap((peer) =>
          (peer.skill?.name ?? peer.installation?.skillName) === selectedName
            ? [peer.id]
            : [],
        );
        if (peerIds.length) {
          await prisma.skillSyncItem.updateMany({
            where: { id: { in: peerIds } },
            data: { resolution: "DATABASE", status: "READY" },
          });
        }
      }
    }
    await this.refreshRunStatus(item.runId);
    return this.getRun(item.runId);
  }

  private async importCandidates(runId: string) {
    const prisma = await getPrismaClient();
    const items = await prisma.skillSyncItem.findMany({
      where: {
        runId,
        status: "READY",
        OR: [
          { direction: "IMPORT" },
          { direction: "CONFLICT", resolution: { in: ["TARGET", "MANUAL"] } },
        ],
      },
      include: { installation: true },
    });
    for (const item of items) {
      const candidate = parseJson<{ package?: SkillPackage; groupId?: string }>(
        item.candidatePackageJson,
        {},
      );
      if (!candidate.package) continue;
      const existing = await prisma.skill.findUnique({
        where: { name: candidate.package.name },
        include: skillInclude,
      });
      const saved = await this.saveSkill({
        id: existing?.id,
        name: candidate.package.name,
        description: candidate.package.description,
        syncGlobally: existing?.syncGlobally ?? !candidate.groupId,
        groupIds: [
          ...(existing?.groups.map((membership) => membership.groupId) ?? []),
          ...(candidate.groupId ? [candidate.groupId] : []),
        ],
        files: candidate.package.files,
      });
      if (item.installationId) {
        await prisma.skillInstallation.update({
          where: { id: item.installationId },
          data: { skillId: saved.id },
        });
        if (item.targetHash === saved.packageHash) {
          await prisma.skillSyncBaseline.upsert({
            where: { installationId: item.installationId },
            create: {
              id: randomUUID(),
              installationId: item.installationId,
              skillId: saved.id,
              packageHash: saved.packageHash,
            },
            update: {
              skillId: saved.id,
              packageHash: saved.packageHash,
              syncedAt: new Date(),
            },
          });
        }
      }
    }
  }

  async applyRun(runId: string) {
    const prisma = await getPrismaClient();
    const run = await prisma.skillSyncRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const blocked = await prisma.skillSyncItem.count({
      where: { runId, status: "BLOCKED" },
    });
    if (blocked) throw new Error("Resolve all conflicts before applying sync");
    await this.importCandidates(runId);
    const desired = await this.desiredLocations(run);
    const installations = await prisma.skillInstallation.findMany({
      where: { present: true },
    });
    const operations = new Map<string, Array<Record<string, unknown>>>();
    const deploymentRefs = new Map<
      string,
      Array<{ id: string; desiredHash: string }>
    >();
    const addOperation = (
      agentId: string,
      operation: Record<string, unknown>,
    ) => {
      const values = operations.get(agentId) ?? [];
      values.push(operation);
      operations.set(agentId, values);
    };
    const addDeploymentRef = (
      agentId: string,
      deployment: { id: string; desiredHash: string },
    ) => {
      const values = deploymentRefs.get(agentId) ?? [];
      values.push(deployment);
      deploymentRefs.set(agentId, values);
    };
    for (const target of desired) {
      const current = installations.find(
        (installation) =>
          installation.agentId === target.agentId &&
          installation.rootPath === target.rootPath &&
          installation.skillName === target.skill.name,
      );
      if (current?.packageHash === target.skill.packageHash) continue;
      if (current?.tracked) continue;
      addOperation(target.agentId, {
        kind: "WRITE",
        scope: target.scope,
        rootKind: target.rootKind,
        folder: target.folder,
        package: skillPackage(target.skill),
        manageGitExclude: target.scope === "PROJECT",
      });
      const deployment = await prisma.skillDeployment.upsert({
        where: {
          agentId_targetPath: {
            agentId: target.agentId,
            targetPath: target.targetPath,
          },
        },
        create: {
          id: randomUUID(),
          skillId: target.skill.id,
          agentId: target.agentId,
          codebaseId: target.codebaseId,
          worktreeId: target.worktreeId,
          scope: target.scope,
          rootKind: target.rootKind,
          targetPath: target.targetPath,
          desiredHash: target.skill.packageHash,
          status: "PENDING",
        },
        update: {
          skillId: target.skill.id,
          desiredHash: target.skill.packageHash,
          status: "PENDING",
          lastError: null,
        },
      });
      addDeploymentRef(target.agentId, {
        id: deployment.id,
        desiredHash: target.skill.packageHash,
      });
    }
    const cleanupItems = await prisma.skillSyncItem.findMany({
      where: {
        runId,
        direction: { in: ["DELETE_REDUNDANT", "DELETE_MANAGED"] },
        status: "READY",
      },
      include: { installation: true },
    });
    const plannedCleanupIds = new Set(
      cleanupItems.flatMap((item) =>
        item.installationId ? [item.installationId] : [],
      ),
    );
    const importedRedundantCopies = installations.filter(
      (installation) =>
        !plannedCleanupIds.has(installation.id) &&
        !installation.tracked &&
        ["CURSOR", "GITHUB_COPILOT", "CODEX_LEGACY", "OPENCODE"].includes(
          installation.rootKind,
        ) &&
        !desired.some(
          (target) =>
            target.agentId === installation.agentId &&
            target.rootPath === installation.rootPath &&
            target.skill.name === installation.skillName,
        ) &&
        desired.some(
          (target) =>
            target.agentId === installation.agentId &&
            target.scope === installation.scope &&
            target.skill.name === installation.skillName &&
            target.skill.packageHash === installation.packageHash,
        ),
    );
    const copiesToDelete = [
      ...cleanupItems.flatMap((item) =>
        item.installation ? [item.installation] : [],
      ),
      ...importedRedundantCopies,
    ];
    for (const installation of copiesToDelete) {
      if (!installation || installation.tracked) continue;
      const target = await this.targets(installation.agentId);
      const folder =
        installation.scope === "PROJECT"
          ? (target.find(
              (value) =>
                value.codebaseId === installation.codebaseId &&
                value.worktreeId === installation.worktreeId,
            )?.folder ?? null)
          : null;
      if (installation.scope === "PROJECT" && !folder) continue;
      addOperation(installation.agentId, {
        kind: "DELETE",
        scope: installation.scope,
        rootKind: installation.rootKind,
        folder,
        skillName: installation.skillName,
        manageGitExclude: installation.scope === "PROJECT",
      });
    }
    for (const [agentId, agentOperations] of operations) {
      const item = await prisma.skillSyncItem.create({
        data: {
          id: randomUUID(),
          runId,
          agentId,
          direction: "APPLY",
          status: "PENDING",
          candidatePackageJson: JSON.stringify({
            deployments: deploymentRefs.get(agentId) ?? [],
          }),
        },
      });
      await this.agentControl.createJob({
        agentId,
        kind: SKILL_APPLY_JOB_KIND,
        payload: {
          operations: agentOperations,
          syncRunId: runId,
          syncItemId: item.id,
        },
        idempotencyKey: `skills:apply:${runId}:${agentId}`,
        timeoutSeconds: 600,
      });
    }
    await prisma.skillSyncRun.update({
      where: { id: runId },
      data: operations.size
        ? { status: "APPLYING" }
        : { status: "SUCCEEDED", finishedAt: new Date() },
    });
    this.publish(runId);
    return this.getRun(runId);
  }

  private async completeApply(job: CompletionJob) {
    const { syncRunId, syncItemId } = this.completionIds(job);
    if (!syncRunId || !syncItemId) return;
    const prisma = await getPrismaClient();
    const succeeded = job.status === "SUCCEEDED";
    const syncItem = await prisma.skillSyncItem.findUnique({
      where: { id: syncItemId },
    });
    const { deployments: deploymentRefs = [] } = parseJson<{
      deployments?: Array<{ id: string; desiredHash: string }>;
    }>(syncItem?.candidatePackageJson ?? null, {});
    await prisma.skillSyncItem.update({
      where: { id: syncItemId },
      data: {
        status: succeeded ? "COMPLETE" : "FAILED",
        error: succeeded ? null : (job.error ?? "Skill apply failed"),
      },
    });
    const deployments = await prisma.skillDeployment.findMany({
      where: {
        id: { in: deploymentRefs.map((deployment) => deployment.id) },
        agentId: job.agentId,
        status: "PENDING",
      },
      include: { skill: { include: { files: true } } },
    });
    const result = parseJson<{
      results?: Array<{
        kind: string;
        path: string;
        packageHash: string | null;
      }>;
    }>(job.resultJson, {});
    if (succeeded) {
      const configured = await this.configuredByAgent();
      for (const deployment of deployments) {
        const expected = deploymentRefs.find(
          (candidate) => candidate.id === deployment.id,
        );
        const applied = result.results?.find(
          (candidate) =>
            candidate.kind === "WRITE" &&
            candidate.path === deployment.targetPath,
        );
        if (
          !expected ||
          deployment.desiredHash !== expected.desiredHash ||
          applied?.packageHash !== expected.desiredHash
        ) {
          continue;
        }
        const installation = await prisma.skillInstallation.upsert({
          where: {
            agentId_rootPath_skillName: {
              agentId: deployment.agentId,
              rootPath: dirname(deployment.targetPath),
              skillName: deployment.skill.name,
            },
          },
          create: {
            id: randomUUID(),
            skillId: deployment.skillId,
            agentId: deployment.agentId,
            codebaseId: deployment.codebaseId,
            worktreeId: deployment.worktreeId,
            scope: deployment.scope,
            rootKind: deployment.rootKind,
            rootPath: dirname(deployment.targetPath),
            skillName: deployment.skill.name,
            description: deployment.skill.description,
            packageHash: deployment.desiredHash,
            present: true,
            fileCount: deployment.skill.files.length,
            totalBytes: deployment.skill.files.reduce(
              (total, file) => total + file.contents.byteLength,
              0,
            ),
            tracked: false,
            consumersJson: JSON.stringify(
              configured.get(deployment.agentId) ?? [],
            ),
            lastSeenAt: new Date(),
          },
          update: {
            skillId: deployment.skillId,
            codebaseId: deployment.codebaseId,
            worktreeId: deployment.worktreeId,
            scope: deployment.scope,
            rootKind: deployment.rootKind,
            description: deployment.skill.description,
            packageHash: deployment.desiredHash,
            present: true,
            fileCount: deployment.skill.files.length,
            totalBytes: deployment.skill.files.reduce(
              (total, file) => total + file.contents.byteLength,
              0,
            ),
            tracked: false,
            consumersJson: JSON.stringify(
              configured.get(deployment.agentId) ?? [],
            ),
            lastSeenAt: new Date(),
          },
        });
        await prisma.skillSyncBaseline.upsert({
          where: { installationId: installation.id },
          create: {
            id: randomUUID(),
            installationId: installation.id,
            skillId: deployment.skillId,
            packageHash: deployment.desiredHash,
          },
          update: {
            skillId: deployment.skillId,
            packageHash: deployment.desiredHash,
            syncedAt: new Date(),
          },
        });
        await prisma.skillDeployment.update({
          where: { id: deployment.id },
          data: {
            status: "INSTALLED",
            installedHash: deployment.desiredHash,
            lastError: null,
          },
        });
      }
      for (const applied of result.results ?? []) {
        if (applied.kind !== "DELETE") continue;
        await prisma.skillInstallation.updateMany({
          where: {
            agentId: job.agentId,
            rootPath: dirname(applied.path),
            skillName: basename(applied.path),
          },
          data: { present: false, lastSeenAt: new Date() },
        });
      }
    } else {
      for (const deployment of deploymentRefs) {
        await prisma.skillDeployment.updateMany({
          where: {
            id: deployment.id,
            agentId: job.agentId,
            desiredHash: deployment.desiredHash,
            status: "PENDING",
          },
          data: {
            status: "FAILED",
            lastError: job.error ?? "Skill apply failed",
          },
        });
      }
    }
    const remaining = await prisma.skillSyncItem.count({
      where: { runId: syncRunId, direction: "APPLY", status: "PENDING" },
    });
    if (!remaining) {
      const failures = await prisma.skillSyncItem.count({
        where: { runId: syncRunId, direction: "APPLY", status: "FAILED" },
      });
      await prisma.skillSyncRun.update({
        where: { id: syncRunId },
        data: {
          status: failures ? "PARTIAL" : "SUCCEEDED",
          finishedAt: new Date(),
        },
      });
    }
    this.publish(syncRunId);
  }
}
