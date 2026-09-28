import { validateTransferReferences } from "./integrity";
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import {
  parseBuildSource,
  parseBuildAdvancedSettings,
  parseBuildExportSettings,
} from "@ai-development-environment/agent-contract/builds";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import { compileRe2 } from "@/lib/re2.server";
import { validateWorkflowPatterns } from "@/lib/workflows/validation.server";
import {
  parseWorkflowDefinition,
  sanitizeWorkflowExportDefinition,
  validateWorkflowDefinition,
} from "@/lib/workflows/definition";
import {
  agentEventBus,
  CODEBASE_CHANGED_TOPIC,
  COMMANDS_CHANGED_TOPIC,
  BUILD_SCRIPTS_CHANGED_TOPIC,
  SKILLS_CHANGED_TOPIC,
} from "@/services/agent-control";
import type {
  CommandsService,
  CommandDefinitionInput,
} from "@/services/commands/commands.service";
import type { GitHubService } from "@/services/github";
import type { SkillsService } from "@/services/skills";
import {
  decodePreparationContents,
  normalizePreparationPath,
  preparationContentSha256,
  preparationDefinitionHash,
  MAX_REPOSITORY_PREPARATIONS,
  MAX_PREPARATION_TOTAL_BYTES,
} from "@/services/worktrees/preparations";
import { RepositoryCloneService } from "./clone.service";
import {
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  parseTransferPackage,
  pruneAppMembership,
  selectionItems,
  filteredPackage,
  fingerprint,
  jsonValue,
  pick,
  setReference,
  repositoryFields,
  type TransferEntity,
  type TransferPackage,
  type TransferExportInput,
  type TransferImportInput,
  type Dependency,
  type SelectionItem,
  type TransferDestinationInput,
} from "./package";
import { workflowReferences, referenceKey } from "./references";

const commandFields = [
  "name",
  "description",
  "script",
  "targetKind",
  "restartPolicy",
  "restartLimit",
  "concurrency",
  "blocksGitOperations",
  "quickActionEnabled",
  "quickActionIconKey",
  "quickActionButtonVariant",
  "notificationsEnabled",
];
const workflowFields = [
  "name",
  "description",
  "overlapPolicy",
  "overlapScope",
  "maxConcurrentRuns",
  "completionNotificationsEnabled",
  "exclusiveWorktree",
  "worktreeConcurrency",
  "blocksGitOperations",
  "quickActionKind",
  "quickActionIconKey",
  "quickActionButtonVariant",
];
const scriptFields = [
  "name",
  "iconKey",
  "preBuildScript",
  "postBuildScript",
  "enabledByDefault",
  "timeoutSeconds",
  "failureBehavior",
];
const configFields = [
  "name",
  "iconKey",
  "scheme",
  "buildConfiguration",
  "defaultAction",
  "autoExport",
];
const keyFor = (kind: string, id: string) => `${kind.toLowerCase()}:${id}`;
const string = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
const normalizedName = (value: string) =>
  value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
const nameSchema = z.string().trim().min(1).max(120);
const commandServiceInput = (fields: Record<string, unknown>) =>
  fields as CommandDefinitionInput;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Candidate = {
  id: string;
  label: string;
  identity: Record<string, unknown>;
  value: Record<string, unknown>;
  affectedRepositories?: string[];
};
type Resolved = {
  entity: TransferEntity;
  id: string;
  existing: Candidate | null;
  fields: Record<string, unknown>;
  action: "IMPORT" | "KEEP" | "COPY";
};

export class RepositoryTransferService {
  constructor(
    readonly clones: RepositoryCloneService,
    private readonly commands: CommandsService,
    private readonly github: GitHubService,
    private readonly skills?: SkillsService,
  ) {}

  async exportPreview(input: TransferExportInput) {
    const prisma = await getPrismaClient();
    const entities = new Map<string, TransferEntity>();
    const exportCatalog = new Map<string, Candidate[]>();
    const warnings: string[] = [];
    const addRef = async (
      entity: TransferEntity,
      kind: string,
      id: string,
      path: (string | number)[],
      entityDependency = true,
    ) => {
      const bundled = [
        "REPOSITORY",
        "COMMAND",
        "WORKFLOW",
        "WORKFLOW_VERSION",
        "BUILD_CONFIGURATION",
        "BUILD_SCRIPT",
      ].includes(kind);
      const target =
        bundled && entityDependency ? await ensure(kind, id, true) : null;
      if (!exportCatalog.has(kind))
        exportCatalog.set(kind, await this.candidates(kind));
      const candidates = exportCatalog.get(kind)!;
      const candidate = candidates.find((c) => c.id === id);
      const identity = target
        ? {
            ...candidate?.identity,
            ...(target.kind === "REPOSITORY"
              ? { canonicalOrigin: target.fields.canonicalOrigin }
              : { name: target.name }),
          }
        : (candidate?.identity ?? { unavailable: true });
      entity.references.push({
        key: referenceKey(entity.key, path),
        kind,
        path,
        label: candidate?.label ?? target?.name ?? `${kind} (unavailable)`,
        entityKey: target?.key,
        identity,
      });
      setReference(entity.fields, path, null);
    };
    const addWorkflowRefs = async (entity: TransferEntity, field: string) => {
      const raw = entity.fields[field];
      if (!raw) return;
      for (const ref of workflowReferences(raw as Record<string, unknown>, [
        field,
      ]))
        await addRef(entity, ref.kind, ref.id, ref.path);
      const original = JSON.stringify(raw);
      entity.fields[field] = sanitizeWorkflowExportDefinition(
        parseWorkflowDefinition(raw),
      );
      if (JSON.stringify(entity.fields[field]) !== original)
        warnings.push(
          `${entity.name}: machine paths or secret literals were omitted; review the definition before enabling it.`,
        );
    };
    const ensure = async (
      kind: string,
      id: string,
      dependency: boolean,
    ): Promise<TransferEntity | null> => {
      const key = keyFor(kind, id);
      const found = entities.get(key);
      if (found) {
        if (!dependency) found.dependency = false;
        return found;
      }
      const entity: TransferEntity = {
        key,
        kind: kind as TransferEntity["kind"],
        name: key,
        dependency,
        fields: {},
        references: [],
      };
      entities.set(key, entity);
      if (kind === "APP") {
        const app = await prisma.app.findUniqueOrThrow({
          where: { id },
          include: { repositories: true },
        });
        entity.name = app.name;
        entity.fields = {
          name: app.name,
          description: app.description,
          repositoryIds: app.repositories.map((r) => r.repositoryId),
        };
        for (let i = 0; i < app.repositories.length; i++) {
          await ensure("REPOSITORY", app.repositories[i].repositoryId, false);
          await addRef(entity, "REPOSITORY", app.repositories[i].repositoryId, [
            "repositoryIds",
            i,
          ]);
        }
      } else if (kind === "REPOSITORY") {
        const repo = await prisma.codebaseRepository.findUniqueOrThrow({
          where: { id },
          include: {
            preparations: true,
            projects: { include: { configurations: true } },
            skillGroups: { include: { group: true } },
            buildScripts: { orderBy: { position: "asc" } },
            codebases: { orderBy: { id: "asc" } },
          },
        });
        entity.name = repo.name;
        entity.fields = {
          ...pick(repo, repositoryFields),
          canonicalOrigin: repo.canonicalOrigin,
          remoteUrl: this.cloneUrl(
            repo.canonicalOrigin,
            repo.codebases[0]?.observedOrigin,
          ),
        };
        for (const preparation of repo.preparations) {
          const child: TransferEntity = {
            key: keyFor("PREPARATION", preparation.id),
            kind: "PREPARATION",
            name: preparation.path,
            repositoryKey: key,
            parentKey: key,
            dependency: false,
            fields: {
              kind: preparation.kind,
              path: preparation.path,
              contentBase64: preparation.contents
                ? Buffer.from(preparation.contents).toString("base64")
                : null,
            },
            references: [],
          };
          entities.set(child.key, child);
        }
        for (const project of repo.projects)
          for (const config of project.configurations)
            await ensure("BUILD_CONFIGURATION", config.id, false);
        for (const [position, link] of repo.buildScripts.entries()) {
          const script = await ensure(
            "BUILD_SCRIPT",
            link.scriptId,
            dependency,
          );
          if (script) {
            const assignments = (script.fields.assignments ?? []) as unknown[];
            assignments.push({ repositoryId: id, position });
            script.fields.assignments = assignments;
            await addRef(script, "REPOSITORY", id, [
              "assignments",
              assignments.length - 1,
              "repositoryId",
            ]);
          }
        }
        for (const link of repo.skillGroups) {
          const child: TransferEntity = {
            key: `${key}/group/${link.groupId}`,
            kind: "SKILL_GROUP",
            name: link.group.name,
            repositoryKey: key,
            parentKey: key,
            dependency: false,
            fields: { groupId: null },
            references: [],
          };
          entities.set(child.key, child);
          await addRef(
            child,
            "SKILL_GROUP_RESOURCE",
            link.groupId,
            ["groupId"],
            false,
          );
        }
        const rules = await prisma.gitHubAutoRetryRule.findMany({
          where: { codebaseRepositoryId: id, scope: "REPOSITORY" },
          include: { targets: true },
          orderBy: { id: "asc" },
        });
        let workflows: Awaited<
          ReturnType<GitHubService["repositoryWorkflows"]>
        > = [];
        if (rules.some((r) => !r.allWorkflows))
          try {
            workflows = await this.github.repositoryWorkflows(id);
          } catch {
            warnings.push(
              `${repo.name}: GitHub workflow paths could not be loaded; target rules require explicit mapping on import.`,
            );
          }
        for (const rule of rules) {
          const child: TransferEntity = {
            key: keyFor("AUTO_RETRY", rule.id),
            kind: "AUTO_RETRY",
            name: `${repo.name} auto retry`,
            repositoryKey: key,
            parentKey: key,
            dependency: false,
            fields: {
              ...pick(rule, [
                "allWorkflows",
                "mode",
                "retryLimit",
                "failureStrategy",
              ]),
              enabled: false,
              targets: rule.targets.map((t) => ({
                workflowId: t.workflowId,
                jobName: t.jobName,
              })),
            },
            references: [],
          };
          entities.set(child.key, child);
          for (const [i, target] of rule.targets.entries())
            if (target.workflowId) {
              const wf = workflows.find((w) => w.id === target.workflowId);
              const path = ["targets", i, "workflowId"];
              child.references.push({
                key: referenceKey(child.key, path),
                kind: "GITHUB_WORKFLOW",
                path,
                label: wf?.name ?? target.workflowId,
                identity: {
                  canonicalOrigin: repo.canonicalOrigin,
                  workflowPath: wf?.path ?? null,
                  providerId: target.workflowId,
                  repositoryKey: key,
                },
              });
              setReference(child.fields, path, null);
            }
        }
      } else if (kind === "BUILD_CONFIGURATION") {
        const config = await prisma.buildConfiguration.findUniqueOrThrow({
          where: { id },
          include: { source: true, project: { include: { repository: true } } },
        });
        const repoKey = keyFor("REPOSITORY", config.project.repositoryId);
        if (!entities.has(repoKey))
          await ensure("REPOSITORY", config.project.repositoryId, true);
        entity.repositoryKey = repoKey;
        entity.parentKey = repoKey;
        entity.name = config.name;
        const advanced = jsonValue(config.advancedSettingsJson);
        for (const key of [
          "priorBuildForTestingId",
          "priorTestProductsPath",
          "priorXctestrunPath",
        ]) {
          if (advanced[key])
            warnings.push(
              `${config.name}: ${key} is installation-specific and was excluded.`,
            );
          delete advanced[key];
        }
        entity.fields = {
          ...pick(config, configFields),
          sourceKind: config.source.kind,
          sourcePath: config.source.relativePath,
          advancedSettings: advanced,
          exportSettings: config.exportSettingsJson
            ? jsonValue(config.exportSettingsJson)
            : null,
        };
      } else if (kind === "BUILD_SCRIPT") {
        const script = await prisma.buildScript.findUniqueOrThrow({
          where: { id },
        });
        entity.name = script.name;
        entity.fields = { ...pick(script, scriptFields), assignments: [] };
      } else if (kind === "COMMAND") {
        const command = await prisma.commandDefinition.findUniqueOrThrow({
          where: { id },
          include: { repositories: true },
        });
        entity.name = command.name;
        entity.fields = {
          ...pick(command, commandFields),
          targetAgentId: command.targetAgentId,
          targetRepositoryIds: command.repositories.map((r) => r.repositoryId),
        };
        if (command.targetAgentId)
          await addRef(
            entity,
            "AGENT",
            command.targetAgentId,
            ["targetAgentId"],
            false,
          );
        for (const [index, r] of command.repositories.entries())
          await addRef(entity, "REPOSITORY", r.repositoryId, [
            "targetRepositoryIds",
            index,
          ]);
      } else if (kind === "WORKFLOW") {
        const workflow = await prisma.workflow.findUniqueOrThrow({
          where: { id },
          include: { quickActionRepositories: true },
        });
        entity.name = workflow.name;
        entity.fields = {
          ...pick(workflow, workflowFields),
          enabled: false,
          draftDefinition: jsonValue(workflow.draftDefinitionJson),
          activeVersionId: workflow.activeVersionId,
          repositoryIds: workflow.quickActionRepositories.map(
            (r) => r.repositoryId,
          ),
        };
        for (const [index, r] of workflow.quickActionRepositories.entries())
          await addRef(entity, "REPOSITORY", r.repositoryId, [
            "repositoryIds",
            index,
          ]);
        await addWorkflowRefs(entity, "draftDefinition");
        if (workflow.activeVersionId) {
          const version = await ensure(
            "WORKFLOW_VERSION",
            workflow.activeVersionId,
            false,
          );
          if (version)
            await addRef(entity, "WORKFLOW_VERSION", workflow.activeVersionId, [
              "activeVersionId",
            ]);
        }
      } else if (kind === "WORKFLOW_VERSION") {
        const version = await prisma.workflowVersion.findUniqueOrThrow({
          where: { id },
        });
        const owner = await ensure("WORKFLOW", version.workflowId, true);
        entity.name = `${version.name} v${version.version}`;
        entity.parentKey = owner!.key;
        entity.fields = {
          workflowId: version.workflowId,
          name: version.name,
          description: version.description,
          definition: jsonValue(version.definitionJson),
          sourceVersion: version.version,
        };
        await addRef(entity, "WORKFLOW", version.workflowId, ["workflowId"]);
        await addWorkflowRefs(entity, "definition");
      } else {
        entities.delete(key);
        return null;
      }
      return entity;
    };
    await ensure(input.scope, input.id, false);
    const rootKey = keyFor(input.scope, input.id);
    const rootRepoIds = [...entities.values()]
      .filter((e) => e.kind === "REPOSITORY" && !e.dependency)
      .map((e) => e.key.slice("repository:".length));
    const commands = await prisma.commandDefinition.findMany({
      where: {
        archivedAt: null,
        repositories: { some: { repositoryId: { in: rootRepoIds } } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    for (const command of commands) await ensure("COMMAND", command.id, false);
    const workflows = await prisma.workflow.findMany({
      where: {
        archivedAt: null,
        quickActionRepositories: {
          some: { repositoryId: { in: rootRepoIds } },
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    for (const workflow of workflows)
      await ensure("WORKFLOW", workflow.id, false);
    const pack: TransferPackage = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      scope: input.scope,
      rootKey,
      entities: [...entities.values()],
    };
    return {
      payload: pack,
      items: selectionItems(pack, input),
      warnings: [
        ...new Set(warnings),
        "Preparation uploads and authored scripts are included when selected. Review their contents before sharing.",
      ],
    };
  }
  async export(input: TransferExportInput) {
    const preview = await this.exportPreview(input);
    const result = filteredPackage(preview.payload, input);
    if (!result.entities.some((e) => e.key === result.rootKey))
      throw new Error("Select the package root");
    return parseTransferPackage(result);
  }
  private cloneUrl(canonicalOrigin: string, observed?: string) {
    if (observed) {
      try {
        const url = normalizeGitOrigin(observed);
        if (url.canonicalOrigin === canonicalOrigin) {
          if (observed.startsWith("ssh://"))
            return observed.replace(/^ssh:\/\/([^@/]+)\//, "ssh://git@$1/");
          if (!observed.includes("://") && observed.includes(":"))
            return `git@${observed.replace(/^.*@/, "")}`;
          if (observed.startsWith("https://") || observed.startsWith("http://"))
            return url.sanitizedOrigin;
        }
      } catch {}
    }
    return `https://${canonicalOrigin}.git`;
  }

  private async candidates(
    kind: string,
    repositoryId?: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<Candidate[]> {
    const p = transaction ?? (await getPrismaClient());
    switch (kind) {
      case "APP":
        return (await p.app.findMany({ orderBy: { id: "asc" } })).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { name: normalizedName(v.name) },
          value: {
            ...pick(v, ["name", "description"]),
            revision: v.updatedAt.toISOString(),
          },
        }));
      case "REPOSITORY":
        return (
          await p.codebaseRepository.findMany({ orderBy: { id: "asc" } })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { canonicalOrigin: v.canonicalOrigin },
          value: {
            ...pick(v, [...repositoryFields, "canonicalOrigin"]),
            revision: v.updatedAt.toISOString(),
          },
        }));
      case "COMMAND":
        return (
          await p.commandDefinition.findMany({
            where: { archivedAt: null },
            include: { repositories: { include: { repository: true } } },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { name: v.name },
          value: {
            ...pick(v, commandFields),
            targetAgentId: v.targetAgentId,
            targetRepositoryIds: v.repositories.map((r) => r.repositoryId),
            revision: v.updatedAt.toISOString(),
          },
          affectedRepositories: v.repositories.map((r) => r.repository.name),
        }));
      case "WORKFLOW":
        return (
          await p.workflow.findMany({
            where: { archivedAt: null },
            include: {
              quickActionRepositories: { include: { repository: true } },
            },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { name: v.name },
          value: {
            ...pick(v, workflowFields),
            enabled: v.enabled,
            draftDefinition: jsonValue(v.draftDefinitionJson),
            activeVersionId: v.activeVersionId,
            repositoryIds: v.quickActionRepositories.map((r) => r.repositoryId),
            revision: v.updatedAt.toISOString(),
          },
          affectedRepositories: v.quickActionRepositories.map(
            (r) => r.repository.name,
          ),
        }));
      case "WORKFLOW_VERSION":
        return (
          await p.workflowVersion.findMany({
            include: { workflow: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: `${v.name} v${v.version}`,
          identity: {
            workflowName: v.workflow.name,
            contentHash: v.contentHash,
            version: v.version,
          },
          value: {
            definition: jsonValue(v.definitionJson),
            workflowId: v.workflowId,
          },
        }));
      case "BUILD_SCRIPT":
        return (
          await p.buildScript.findMany({
            where: { deletedAt: null },
            include: { repositories: { include: { repository: true } } },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { name: v.name },
          value: {
            ...pick(v, scriptFields),
            revision: v.updatedAt.toISOString(),
          },
          affectedRepositories: v.repositories.map((r) => r.repository.name),
        }));
      case "RESERVED_BUILD_SCRIPT_NAME":
        return (
          await p.buildScript.findMany({
            where: { deletedAt: { not: null } },
            select: { id: true, name: true, deletedAt: true, updatedAt: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { name: v.name },
          value: {
            deletedAt: v.deletedAt?.toISOString(),
            revision: v.updatedAt.toISOString(),
          },
        }));
      case "BUILD_CONFIGURATION":
        return (
          await p.buildConfiguration.findMany({
            where: repositoryId ? { project: { repositoryId } } : {},
            include: {
              project: { include: { repository: true } },
              source: true,
            },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: {
            name: v.name,
            canonicalOrigin: v.project.repository.canonicalOrigin,
          },
          value: {
            ...pick(v, configFields),
            sourceKind: v.source.kind,
            sourcePath: v.source.relativePath,
            advancedSettings: jsonValue(v.advancedSettingsJson),
            exportSettings: v.exportSettingsJson
              ? jsonValue(v.exportSettingsJson)
              : null,
            revision: v.updatedAt.toISOString(),
          },
        }));
      case "PREPARATION":
        return (
          await p.codebaseRepositoryPreparation.findMany({
            where: { repositoryId },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.path,
          identity: { path: v.path },
          value: {
            kind: v.kind,
            path: v.path,
            contentBase64: v.contents
              ? Buffer.from(v.contents).toString("base64")
              : null,
            revision: v.updatedAt.toISOString(),
          },
        }));
      case "SKILL_GROUP_RESOURCE":
        return (await p.skillGroup.findMany({ orderBy: { id: "asc" } })).map(
          (v) => ({
            id: v.id,
            label: v.name,
            identity: { name: v.name },
            value: { name: v.name },
          }),
        );
      case "AGENT":
        return (await p.agent.findMany({ orderBy: { id: "asc" } })).map(
          (v) => ({
            id: v.id,
            label: `${v.name} (${v.hostname})`,
            identity: { name: v.name, hostname: v.hostname },
            value: { name: v.name },
          }),
        );
      case "CODEBASE":
        return (
          await p.codebase.findMany({
            include: { repository: true, agent: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: `${v.repository.name} — ${v.agent.name}: ${v.folder}`,
          identity: {
            canonicalOrigin: v.repository.canonicalOrigin,
            agentName: v.agent.name,
          },
          value: {
            repositoryId: v.repositoryId,
            agentId: v.agentId,
            folder: v.folder,
          },
        }));
      case "WORKTREE":
        return (
          await p.worktree.findMany({
            where: { missingAt: null },
            include: {
              codebase: { include: { repository: true, agent: true } },
            },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: `${v.codebase.repository.name}: ${v.branch ?? v.id}`,
          identity: {
            canonicalOrigin: v.codebase.repository.canonicalOrigin,
            branch: v.branch,
            agentName: v.codebase.agent.name,
          },
          value: {},
        }));
      case "GITHUB_REPOSITORY":
        return (
          await p.gitHubRepository.findMany({ orderBy: { id: "asc" } })
        ).map((v) => ({
          id: v.githubId,
          label: v.nameWithOwner,
          identity: { name: v.nameWithOwner },
          value: {},
        }));
      case "AUTO_RETRY":
        return (
          await p.gitHubAutoRetryRule.findMany({
            where: { scope: "REPOSITORY", codebaseRepositoryId: repositoryId },
            include: { targets: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: `Auto retry (${v.mode})`,
          identity: { mode: v.mode },
          value: {
            ...pick(v, [
              "allWorkflows",
              "mode",
              "retryLimit",
              "failureStrategy",
              "enabled",
            ]),
            targets: v.targets.map((t) => ({
              workflowId: t.workflowId,
              jobName: t.jobName,
            })),
            revision: v.updatedAt.toISOString(),
          },
        }));
      case "MCP_SERVER":
        return (
          await p.externalMcpServer.findMany({
            select: { id: true, name: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { name: v.name },
          value: {},
        }));
      case "MCP_PRESET":
        return (
          await p.mcpToolPreset.findMany({
            select: { id: true, name: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.name,
          identity: { name: v.name },
          value: {},
        }));
      case "CREDENTIAL":
        return (
          await p.credential.findMany({
            select: { id: true, kind: true, ownerId: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: `${v.kind}${v.ownerId ? ` (${v.ownerId})` : ""}`,
          identity: { kind: v.kind },
          value: { kind: v.kind, ownerId: v.ownerId },
        }));
      case "APNS_CHANNEL":
        return (
          await p.apnsBroadcastChannel.findMany({
            select: { id: true, bundleId: true, environment: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: `${v.bundleId} (${v.environment})`,
          identity: { bundleId: v.bundleId, environment: v.environment },
          value: {},
        }));
      case "APNS_REGISTRATION":
        return (
          await p.apnsRegistration.findMany({
            select: {
              id: true,
              displayName: true,
              topic: true,
              environment: true,
            },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: v.displayName,
          identity: {
            name: v.displayName,
            topic: v.topic,
            environment: v.environment,
          },
          value: {},
        }));
      case "RUN":
        return (
          await p.agentRun.findMany({
            select: { id: true, displayNumber: true, repositoryName: true },
            orderBy: { id: "asc" },
          })
        ).map((v) => ({
          id: v.id,
          label: `${v.repositoryName} #${v.displayNumber}`,
          identity: {},
          value: {},
        }));
      default:
        return [];
    }
  }

  private async review(input: TransferImportInput) {
    const pack = parseTransferPackage(input.payload);
    validateTransferReferences(pack);
    const items = selectionItems(pack, input);
    const blockers: string[] = [];
    const warnings = [
      "Selected incoming values replace matches. Unlisted and excluded local items are preserved. Repository targets and assignments are merged with existing assignments.",
      "Imported workflows and auto-retry rules remain disabled unless explicitly enabled after validation.",
    ];
    const choices = new Map((input.choices ?? []).map((c) => [c.key, c]));
    const mappings = new Map(
      (input.mappings ?? []).map((m) => [m.key, m.targetId]),
    );
    if (
      choices.size !== (input.choices ?? []).length ||
      mappings.size !== (input.mappings ?? []).length
    )
      throw new Error("Duplicate choices or mappings");
    const sourceKey =
      input.sourceRepositoryKey ??
      (pack.scope === "REPOSITORY"
        ? pack.rootKey
        : pack.entities.find((e) => e.kind === "REPOSITORY" && !e.dependency)
            ?.key);
    if (
      input.targetRepositoryId &&
      !pack.entities.some((e) => e.kind === "REPOSITORY" && e.key === sourceKey)
    )
      throw new Error("Select a source repository template");
    if (input.targetRepositoryId) {
      for (const item of items)
        if (
          item.kind === "APP" ||
          (item.repositoryKey &&
            item.repositoryKey !== sourceKey &&
            !(input.includedKeys ?? []).includes(item.repositoryKey))
        )
          item.selected = false;
      warnings.push(
        "Template import retains the destination Git origin and checkout identity.",
      );
    }
    const active = new Set(
      items.filter((i) => i.selected && i.kind !== "SETTING").map((i) => i.key),
    );
    const resolved = new Map<string, Resolved>();
    const catalog = new Map<string, Candidate[]>();
    const load = async (kind: string, repositoryId?: string) => {
      const key = JSON.stringify([kind, repositoryId ?? null]);
      if (!catalog.has(key))
        catalog.set(key, await this.candidates(kind, repositoryId));
      return catalog.get(key)!;
    };
    const ordered = [...pack.entities].sort(
      (a, b) =>
        (a.kind === "REPOSITORY" ? -1 : 0) - (b.kind === "REPOSITORY" ? -1 : 0),
    );
    for (const originalEntity of ordered) {
      if (!active.has(originalEntity.key)) continue;
      const entity = pruneAppMembership(originalEntity, active);
      const item = items.find((i) => i.key === entity.key)!;
      const choice = choices.get(entity.key);
      item.action = choice?.action ?? "IMPORT";
      let repositoryId = entity.repositoryKey
        ? resolved.get(entity.repositoryKey)?.id
        : undefined;
      if (repositoryId?.startsWith("planned:")) repositoryId = undefined;
      let candidates =
        entity.kind === "SKILL_GROUP"
          ? []
          : await load(entity.kind, repositoryId);
      if (
        entity.repositoryKey &&
        !repositoryId &&
        ["PREPARATION", "BUILD_CONFIGURATION", "AUTO_RETRY"].includes(
          entity.kind,
        )
      )
        candidates = [];
      let matches: Candidate[] = [];
      const explicitId =
        entity.kind === "REPOSITORY" &&
        input.targetRepositoryId &&
        entity.key === sourceKey
          ? input.targetRepositoryId
          : choice?.targetId;
      if (explicitId) {
        matches = candidates.filter((c) => c.id === explicitId);
        if (!matches.length)
          blockers.push(
            `${entity.name}: the selected destination no longer exists`,
          );
      } else if (entity.kind === "REPOSITORY")
        matches = candidates.filter(
          (c) => c.identity.canonicalOrigin === entity.fields.canonicalOrigin,
        );
      else if (entity.kind === "APP")
        matches = candidates.filter(
          (c) => c.identity.name === normalizedName(entity.name),
        );
      else if (entity.kind === "PREPARATION")
        matches = candidates.filter(
          (c) => c.identity.path === entity.fields.path,
        );
      else if (entity.kind === "AUTO_RETRY") matches = candidates;
      else if (entity.kind !== "WORKFLOW_VERSION")
        matches = candidates.filter((c) => c.identity.name === entity.name);
      if (matches.length > 1 && !explicitId && item.action !== "COPY")
        blockers.push(
          `${entity.name}: multiple matching items exist; choose an explicit destination or create a copy`,
        );
      const existing = matches.length === 1 ? matches[0] : null;
      if (
        item.action === "COPY" &&
        ![
          "APP",
          "COMMAND",
          "WORKFLOW",
          "BUILD_SCRIPT",
          "BUILD_CONFIGURATION",
        ].includes(entity.kind)
      )
        blockers.push(`${entity.name}: copying this item is not supported`);
      if (item.action === "KEEP" && !existing && entity.kind !== "SKILL_GROUP")
        blockers.push(`${entity.name}: no existing item can be kept`);
      const fields = structuredClone(entity.fields);
      if (
        entity.kind === "WORKFLOW" &&
        !Object.hasOwn(fields, "activeVersionId")
      )
        fields.activeVersionId = existing?.value.activeVersionId ?? null;
      if (choice?.name) fields.name = choice.name;
      if (item.action === "COPY" && !choice?.name)
        fields.name = `${entity.name} (imported)`;
      if (entity.kind === "REPOSITORY")
        for (const field of repositoryFields) {
          const row = items.find(
            (i) => i.key === `${entity.key}/field/${field}`,
          );
          const fieldChoice = choices.get(`${entity.key}/field/${field}`);
          if (!row?.selected || fieldChoice?.action === "KEEP")
            delete fields[field];
        }
      if (
        entity.kind === "REPOSITORY" &&
        existing &&
        input.targetRepositoryId &&
        entity.key === sourceKey
      ) {
        fields.canonicalOrigin = existing.identity.canonicalOrigin;
        fields.remoteUrl = this.cloneUrl(
          string(existing.identity.canonicalOrigin),
        );
      }
      if (
        item.action !== "KEEP" &&
        ["APP", "BUILD_SCRIPT", "BUILD_CONFIGURATION"].includes(entity.kind) &&
        candidates.some(
          (c) =>
            (item.action === "COPY" || c.id !== existing?.id) &&
            c.identity.name ===
              (entity.kind === "APP"
                ? normalizedName(string(fields.name))
                : fields.name),
        )
      )
        blockers.push(
          `${entity.name}: another item already uses this name; select that destination or choose a unique name for a copy`,
        );
      if (entity.kind === "BUILD_SCRIPT" && item.action !== "KEEP") {
        const reservedNames = await load("RESERVED_BUILD_SCRIPT_NAME");
        if (
          reservedNames.some(
            (candidate) => candidate.identity.name === fields.name,
          )
        )
          blockers.push(
            `${entity.name}: this name belongs to a deleted build script; restore that script or create a copy with a unique name`,
          );
      }
      const id =
        existing && item.action !== "COPY"
          ? existing.id
          : `planned:${entity.key}`;
      item.targetId = existing?.id ?? null;
      item.current = existing
        ? Object.fromEntries(
            Object.entries(existing.value).filter(
              ([key]) => key !== "revision",
            ),
          )
        : null;
      item.incoming = fields;
      item.affectedRepositories = existing?.affectedRepositories ?? [];
      item.candidates = candidates.map(({ id, label }) => ({ id, label }));
      if (
        existing?.value.enabled === true &&
        ["WORKFLOW", "AUTO_RETRY"].includes(entity.kind) &&
        item.action !== "KEEP"
      )
        item.warnings.push(
          "The existing automation will be disabled by this import.",
        );
      resolved.set(entity.key, {
        entity,
        id,
        existing: item.action === "COPY" ? null : existing,
        fields:
          item.action === "KEEP" && existing
            ? { ...fields, ...existing.value }
            : fields,
        action: item.action,
      });
      for (const row of items.filter(
        (i) => i.parentKey === entity.key && i.kind === "SETTING",
      )) {
        const field = row.key.split("/").at(-1)!;
        row.current = existing?.value[field] ?? null;
        row.targetId = item.targetId;
        row.action = choices.get(row.key)?.action ?? item.action;
      }
    }
    const targetOwners = new Map<string, string>();
    for (const v of resolved.values()) {
      if (v.action === "KEEP" || v.entity.kind === "SKILL_GROUP") continue;
      const identity = v.existing
        ? `${v.entity.kind}:${v.id}`
        : JSON.stringify([
            v.entity.kind,
            v.entity.repositoryKey ?? null,
            v.entity.kind === "REPOSITORY"
              ? v.fields.canonicalOrigin
              : v.entity.kind === "PREPARATION"
                ? v.fields.path
                : (v.fields.name ?? v.entity.key),
          ]);
      const previous = targetOwners.get(identity);
      if (previous)
        blockers.push(
          `${v.entity.name}: more than one selected item targets the same destination; choose a copy or exclude one`,
        );
      else targetOwners.set(identity, v.entity.key);
      if (
        v.entity.kind === "REPOSITORY" &&
        v.existing &&
        v.fields.canonicalOrigin !== v.existing.identity.canonicalOrigin
      )
        blockers.push(
          `${v.entity.name}: use repository template import to target a different Git origin`,
        );
      if (
        v.entity.kind === "COMMAND" &&
        v.existing?.value.targetKind === "REPOSITORY_WORKTREE" &&
        v.fields.targetKind !== "REPOSITORY_WORKTREE"
      )
        blockers.push(
          `${v.entity.name}: create a copy to change a repository-scoped command to another target scope`,
        );
    }
    const dependencies: Dependency[] = [];
    for (const value of resolved.values()) {
      if (value.action === "KEEP") continue;
      for (const ref of value.entity.references) {
        if (!this.hasReferencePath(value.fields, ref.path)) continue;
        // Excluding the published snapshot keeps an existing active version; new workflows stay unpublished.
        if (
          value.entity.kind === "WORKFLOW" &&
          ref.path[0] === "activeVersionId" &&
          ref.entityKey &&
          input.excludedKeys?.includes(ref.entityKey)
        ) {
          value.fields.activeVersionId =
            value.existing?.value.activeVersionId ?? null;
          continue;
        }
        let local: Candidate | null = null;
        const bundled = ref.entityKey ? resolved.get(ref.entityKey) : null;
        let candidates: Candidate[] = [];
        let targetId: string | null = null;
        if (ref.kind === "GITHUB_WORKFLOW") {
          const repo = resolved.get(value.entity.repositoryKey ?? "");
          if (repo)
            try {
              const workflows = repo.id.startsWith("planned:")
                ? await this.github.repositoryWorkflowsForOrigin(
                    String(repo.fields.canonicalOrigin),
                  )
                : await this.github.repositoryWorkflows(repo.id);
              candidates = workflows.map((w) => ({
                id: w.id,
                label: w.name,
                identity: {
                  workflowPath: w.path,
                  canonicalOrigin: repo.fields.canonicalOrigin,
                },
                value: {},
              }));
            } catch {
              /* The unresolved mapping is displayed below. */
            }
        } else candidates = await load(ref.kind);
        if (ref.kind === "CODEBASE") {
          candidates = [
            ...candidates,
            ...(input.destinations ?? []).flatMap((d) => {
              const repository = resolved.get(d.repositoryKey);
              if (!repository) return [];
              const existing = candidates.find(
                (c) =>
                  c.value.repositoryId === repository.id &&
                  c.value.agentId === d.agentId,
              );
              if (existing) return [];
              return [
                {
                  id: `planned:checkout:${d.repositoryKey}:${d.agentId}`,
                  label: `${repository.entity.name} — selected agent checkout`,
                  identity: {
                    canonicalOrigin: repository.fields.canonicalOrigin,
                  },
                  value: { repositoryId: repository.id, agentId: d.agentId },
                },
              ];
            }),
          ];
        }
        const explicit = mappings.get(ref.key);
        if (explicit) {
          local = candidates.find((c) => c.id === explicit) ?? null;
          if (!local)
            blockers.push(
              `${ref.label}: the selected mapping is not a valid ${ref.kind} resource`,
            );
          targetId = local?.id ?? null;
        } else if (bundled) {
          targetId = bundled.id;
        } else if (
          !["AGENT", "WORKTREE", "CODEBASE", "CREDENTIAL", "RUN"].includes(
            ref.kind,
          ) &&
          (ref.kind !== "GITHUB_WORKFLOW" || Boolean(ref.identity.workflowPath))
        ) {
          const identity = ref.identity;
          const matches = candidates.filter(
            (c) =>
              Object.entries(identity)
                .filter(
                  ([key, v]) =>
                    v !== null &&
                    !["repositoryKey", "providerId", "unavailable"].includes(
                      key,
                    ) &&
                    !(
                      ref.kind === "GITHUB_WORKFLOW" &&
                      key === "canonicalOrigin"
                    ),
                )
                .every(([key, v]) => c.identity[key] === v) &&
              Object.keys(identity).some((k) => Object.hasOwn(c.identity, k)),
          );
          if (matches.length === 1) {
            local = matches[0];
            targetId = local.id;
          }
        }
        const dep: Dependency = {
          key: ref.key,
          itemKey: value.entity.key,
          kind: ref.kind,
          label: ref.label,
          targetId: targetId?.startsWith("planned:") ? null : targetId,
          resolved: Boolean(targetId),
          candidates: candidates.map((c) => ({ id: c.id, label: c.label })),
        };
        dependencies.push(dep);
        if (!targetId)
          blockers.push(
            `${value.entity.name}: map or include ${ref.label}, or exclude this item`,
          );
        else {
          setReference(value.fields, ref.path, targetId);
          if (ref.kind === "CREDENTIAL" && local) {
            setReference(
              value.fields,
              [...ref.path.slice(0, -1), "kind"],
              local.value.kind,
            );
            setReference(
              value.fields,
              [...ref.path.slice(0, -1), "ownerId"],
              local.value.ownerId,
            );
          }
        }
      }
      try {
        value.fields = this.validateFields(
          value.entity,
          value.fields,
          value.existing?.value,
        );
      } catch (error) {
        blockers.push(`${value.entity.name}: ${errorMessage(error)}`);
      }
    }
    // Validate merged preparation limits and mutations that would invalidate applied rules.
    const prisma = await getPrismaClient();
    for (const repo of resolved.values())
      if (repo.entity.kind === "REPOSITORY") {
        const existing = repo.id.startsWith("planned:")
          ? []
          : await prisma.codebaseRepositoryPreparation.findMany({
              where: { repositoryId: repo.id },
              include: { statuses: true },
            });
        const incoming = [...resolved.values()].filter(
          (v) =>
            v.entity.kind === "PREPARATION" &&
            v.entity.repositoryKey === repo.entity.key &&
            v.action !== "KEEP",
        );
        const merged = new Map(existing.map((p) => [p.path, p.byteCount ?? 0]));
        for (const prep of incoming) {
          const current = existing.find((p) => p.id === prep.id);
          if (
            current &&
            (current.kind !== prep.fields.kind ||
              current.path !== prep.fields.path) &&
            current.statuses.some(
              (s) => !["UNDONE", "NOT_APPLICABLE"].includes(s.state),
            )
          )
            blockers.push(
              `${prep.entity.name}: undo the existing preparation on every worktree before changing its kind`,
            );
          if (current && current.path !== prep.fields.path)
            merged.delete(current.path);
          try {
            merged.set(
              string(prep.fields.path),
              prep.fields.kind === "WRITE"
                ? decodePreparationContents(string(prep.fields.contentBase64))
                    .length
                : 0,
            );
          } catch {
            /* Field validation already reports the blocker. */
          }
        }
        if (
          merged.size > MAX_REPOSITORY_PREPARATIONS ||
          [...merged.values()].reduce((a, b) => a + b, 0) >
            MAX_PREPARATION_TOTAL_BYTES
        )
          blockers.push(
            `${repo.entity.name}: merged preparations exceed the repository limits`,
          );
      }
    const destinationsInput = (input.destinations ?? []).map((d) => {
      const repo = resolved.get(d.repositoryKey);
      if (!repo || repo.entity.kind !== "REPOSITORY")
        throw new Error(
          "A clone destination must reference a selected repository",
        );
      const remoteUrl = d.remoteUrl || string(repo.fields.remoteUrl);
      if (
        normalizeGitOrigin(remoteUrl).canonicalOrigin !==
        repo.fields.canonicalOrigin
      )
        throw new Error(
          "Clone URL must match the destination repository origin",
        );
      return {
        ...d,
        remoteUrl,
        repositoryId: repo.id.startsWith("planned:") ? null : repo.id,
      };
    });
    const selectedDestinations =
      await this.clones.previewDestinations(destinationsInput);
    for (const d of selectedDestinations)
      if (d.status === "BLOCKED")
        blockers.push(d.error ?? "Clone destination is blocked");
    if (
      pack.scope === "APP" &&
      !input.targetRepositoryId &&
      !selectedDestinations.length
    )
      blockers.push("Select at least one destination agent for this app");
    const agents = await this.clones.agents();
    const selectedPairs = new Set(
      destinationsInput.map((d) => `${d.repositoryKey}:${d.agentId}`),
    );
    const coverageInput = [...resolved.values()]
      .filter((value) => value.entity.kind === "REPOSITORY")
      .flatMap((repo) =>
        agents
          .filter(
            (agent) => !selectedPairs.has(`${repo.entity.key}:${agent.id}`),
          )
          .map((agent) => ({
            repositoryKey: repo.entity.key,
            repositoryId: repo.id.startsWith("planned:") ? null : repo.id,
            agentId: agent.id,
            remoteUrl: string(repo.fields.remoteUrl),
          })),
      );
    // Show registered checkout coverage before the user chooses an agent. Only
    // selected pairs receive on-agent inspection or become operation items.
    const destinations = [...selectedDestinations];
    for (let offset = 0; offset < coverageInput.length; offset += 500)
      destinations.push(
        ...(await this.clones.previewDestinations(
          coverageInput.slice(offset, offset + 500),
          { inspect: false },
        )),
      );
    const app = [...resolved.values()].find((v) => v.entity.kind === "APP");
    if (app && !strings(app.fields.repositoryIds).length)
      blockers.push("An app requires at least one repository");
    for (const key of input.enableWorkflowKeys ?? []) {
      const value = resolved.get(key);
      if (
        !value ||
        value.entity.kind !== "WORKFLOW" ||
        !value.fields.activeVersionId
      )
        blockers.push(
          "Only workflows with a selected published version can be enabled",
        );
    }
    // Validate pinned subworkflow chains with the same snapshots that will be stored.
    const versions = new Map(
      (await load("WORKFLOW_VERSION")).map((v) => [
        v.id,
        {
          definition: v.value.definition,
          workflowId: string(v.value.workflowId),
        },
      ]),
    );
    for (const v of resolved.values())
      if (v.entity.kind === "WORKFLOW_VERSION")
        versions.set(v.id, {
          definition: v.fields.definition,
          workflowId: string(v.fields.workflowId),
        });
    const publishedWorkflows = new Map(
      (await load("WORKFLOW")).map((v) => [v.id, Boolean(v.value.enabled)]),
    );
    for (const w of resolved.values())
      if (w.entity.kind === "WORKFLOW" && w.action !== "KEEP")
        publishedWorkflows.set(
          w.id,
          (input.enableWorkflowKeys ?? []).includes(w.entity.key),
        );
    const inspectVersion = (
      id: string,
      stack: Set<string>,
      requireEnabled: boolean,
    ): void => {
      if (stack.has(id) || stack.size > 64)
        throw new Error(
          "Pinned subworkflow versions contain a cycle or exceed the nesting limit",
        );
      const version = versions.get(id);
      if (!version)
        throw new Error("A pinned workflow version could not be found");
      const next = new Set([...stack, id]);
      for (const ref of workflowReferences(
        version.definition as Record<string, unknown>,
        [],
      ).filter((r) => r.kind === "WORKFLOW_VERSION")) {
        const child = versions.get(ref.id);
        if (!child)
          throw new Error("A pinned subworkflow version could not be found");
        if (requireEnabled && !publishedWorkflows.get(child.workflowId))
          throw new Error(
            "Enable each imported subworkflow dependency before enabling its caller",
          );
        inspectVersion(ref.id, next, requireEnabled);
      }
    };
    for (const v of resolved.values()) {
      if (
        v.entity.kind === "WORKFLOW" &&
        typeof v.fields.activeVersionId === "string"
      ) {
        const version = versions.get(v.fields.activeVersionId);
        if (version && version.workflowId !== v.id)
          blockers.push(
            `${v.entity.name}: the published version belongs to a different workflow`,
          );
      }
      try {
        if (v.entity.kind === "WORKFLOW_VERSION" && v.action !== "KEEP")
          inspectVersion(v.id, new Set(), false);
        if (
          v.entity.kind === "WORKFLOW" &&
          (input.enableWorkflowKeys ?? []).includes(v.entity.key) &&
          typeof v.fields.activeVersionId === "string"
        )
          inspectVersion(v.fields.activeVersionId, new Set(), true);
      } catch (error) {
        blockers.push(`${v.entity.name}: ${errorMessage(error)}`);
      }
    }
    const stamp = fingerprint({
      input,
      items,
      dependencies,
      destinations: destinations.map((d) =>
        pick(d, [
          "repositoryKey",
          "repositoryId",
          "agentId",
          "remoteUrl",
          "relativePath",
          "destinationPath",
          "status",
          "codebaseId",
          "error",
        ]),
      ),
      catalog: [...catalog],
      agents,
    });
    return {
      preview: {
        fingerprint: stamp,
        items,
        dependencies,
        agents,
        destinations,
        warnings,
        blockers: [...new Set(blockers)],
      },
      pack,
      resolved,
      catalog,
      selectedDestinations,
    };
  }
  private hasReferencePath(
    fields: Record<string, unknown>,
    path: (string | number)[],
  ) {
    let v: unknown = fields;
    for (const key of path) {
      if (!v || typeof v !== "object" || !Object.hasOwn(v, key)) return false;
      v = (v as Record<string, unknown>)[key];
    }
    return true;
  }
  async preview(input: TransferImportInput) {
    return (await this.review(input)).preview;
  }

  private validateFields(
    entity: TransferEntity,
    fields: Record<string, unknown>,
    existing?: Record<string, unknown>,
  ): Record<string, unknown> {
    const f = { ...fields };
    switch (entity.kind) {
      case "APP":
        return {
          name: nameSchema.parse(f.name),
          description: z
            .string()
            .max(2000)
            .parse(f.description ?? ""),
          repositoryIds: z
            .array(z.string().min(1))
            .min(1)
            .parse(f.repositoryIds),
        };
      case "REPOSITORY": {
        const origin = normalizeGitOrigin(string(f.remoteUrl));
        if (origin.canonicalOrigin !== f.canonicalOrigin)
          throw new Error(
            "Clone URL and canonical repository identity do not match",
          );
        if (Object.hasOwn(f, "name")) f.name = nameSchema.parse(f.name);
        else if (!existing) f.name = nameSchema.parse(entity.name);
        if (Object.hasOwn(f, "description"))
          f.description = z.string().max(2000).parse(f.description);
        if (Object.hasOwn(f, "keepBaseBranchUpToDate"))
          f.keepBaseBranchUpToDate = z
            .boolean()
            .parse(f.keepBaseBranchUpToDate);
        if (Object.hasOwn(f, "jiraBranchRegex")) {
          f.jiraBranchRegex = z
            .string()
            .max(2000)
            .nullable()
            .parse(f.jiraBranchRegex);
          if (f.jiraBranchRegex)
            compileRe2(string(f.jiraBranchRegex), {
              flags: "i",
              label: "Jira branch regex",
            });
        }
        return f;
      }
      case "PREPARATION": {
        const kind = z
          .enum(["WRITE", "DELETE", "ASSUME_UNCHANGED"])
          .parse(f.kind);
        const path = normalizePreparationPath(string(f.path));
        if (kind === "WRITE")
          decodePreparationContents(z.string().parse(f.contentBase64));
        else if (f.contentBase64)
          throw new Error(
            "Only write preparations may include uploaded contents",
          );
        return {
          kind,
          path,
          contentBase64: kind === "WRITE" ? f.contentBase64 : null,
        };
      }
      case "BUILD_CONFIGURATION": {
        nameSchema.parse(f.name);
        z.string().min(1).max(256).parse(f.scheme);
        z.string().min(1).max(256).parse(f.buildConfiguration);
        z.enum([
          "BUILD",
          "TEST",
          "ARCHIVE",
          "ANALYZE",
          "BUILD_FOR_TESTING",
          "TEST_WITHOUT_BUILDING",
        ]).parse(f.defaultAction);
        const source = parseBuildSource({
          kind: f.sourceKind,
          relativePath: f.sourcePath,
        });
        const advanced = parseBuildAdvancedSettings(f.advancedSettings ?? {});
        if (
          advanced.priorBuildForTestingId ||
          advanced.priorTestProductsPath ||
          advanced.priorXctestrunPath
        )
          throw new Error(
            "Historical builds and machine test-product paths cannot be imported",
          );
        const autoExport = z.boolean().parse(f.autoExport ?? false);
        const exportSettings = f.exportSettings
          ? parseBuildExportSettings(f.exportSettings)
          : null;
        if (autoExport && (f.defaultAction !== "ARCHIVE" || !exportSettings))
          throw new Error(
            "Automatic export requires an Archive configuration and export settings",
          );
        return {
          ...pick(f, configFields),
          sourceKind: source.kind,
          sourcePath: source.relativePath,
          advancedSettings: advanced,
          autoExport,
          exportSettings,
        };
      }
      case "BUILD_SCRIPT": {
        nameSchema.parse(f.name);
        const preBuildScript = z
          .string()
          .max(1000000)
          .nullable()
          .parse(f.preBuildScript ?? null);
        const postBuildScript = z
          .string()
          .max(1000000)
          .nullable()
          .parse(f.postBuildScript ?? null);
        if (!preBuildScript?.trim() && !postBuildScript?.trim())
          throw new Error("At least one build script is required");
        return {
          ...pick(f, scriptFields),
          preBuildScript,
          postBuildScript,
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(3600)
            .parse(f.timeoutSeconds ?? 300),
          enabledByDefault: z.boolean().parse(f.enabledByDefault ?? false),
          failureBehavior: z
            .enum(["FAIL_BUILD", "CONTINUE"])
            .parse(f.failureBehavior),
          assignments: f.assignments ?? [],
        };
      }
      case "COMMAND":
        return this.commands.normalizeDefinition(commandServiceInput(f));
      case "WORKFLOW": {
        const definition = parseWorkflowDefinition(f.draftDefinition);
        if (Buffer.byteLength(JSON.stringify(definition)) > 2 * 1024 * 1024)
          throw new Error("Workflow definition is too large");
        const policy = z
          .enum(["QUEUE", "CONCURRENT", "COALESCE_LATEST"])
          .parse(f.overlapPolicy ?? "QUEUE");
        const concurrency = z
          .enum(["EXCLUSIVE", "NON_EXCLUSIVE", "EXCLUDED"])
          .parse(f.worktreeConcurrency ?? "NON_EXCLUSIVE");
        const repositoryIds = z
          .array(z.string().min(1))
          .parse(f.repositoryIds ?? []);
        if (
          entity.references.some((r) => r.path[0] === "repositoryIds") &&
          !repositoryIds.length
        )
          throw new Error("A repository-scoped workflow cannot become global");
        return {
          ...pick(f, workflowFields),
          name: z.string().trim().min(1).max(200).parse(f.name),
          description: z
            .string()
            .max(2000)
            .parse(f.description ?? ""),
          draftDefinition: {
            ...definition,
            name: string(f.name),
            description: string(f.description),
          },
          activeVersionId: f.activeVersionId ?? null,
          repositoryIds,
          enabled: false,
          overlapPolicy: policy,
          overlapScope: z
            .enum(["GLOBAL", "WORKTREE"])
            .parse(f.overlapScope ?? "WORKTREE"),
          maxConcurrentRuns: z
            .number()
            .int()
            .min(1)
            .max(32)
            .parse(f.maxConcurrentRuns ?? 1),
          worktreeConcurrency: concurrency,
          exclusiveWorktree: concurrency === "EXCLUSIVE",
          blocksGitOperations:
            concurrency === "EXCLUSIVE" ||
            z.boolean().parse(f.blocksGitOperations ?? false),
          completionNotificationsEnabled: z
            .boolean()
            .parse(f.completionNotificationsEnabled ?? true),
          quickActionKind: z
            .enum(["NONE", "STANDARD", "MERGE_CONFLICT", "GITHUB_ACTIONS"])
            .parse(f.quickActionKind ?? "NONE"),
        };
      }
      case "WORKFLOW_VERSION": {
        const result = validateWorkflowDefinition(f.definition);
        const diagnostics = [
          ...result.diagnostics,
          ...(result.definition
            ? validateWorkflowPatterns(result.definition, result.diagnostics)
            : []),
        ];
        const errors = diagnostics.filter((d) => d.severity === "ERROR");
        if (!result.definition || errors.length)
          throw new Error(
            errors.map((d) => d.message).join("; ") ||
              "Invalid workflow version",
          );
        return {
          ...f,
          definition: result.definition,
          workflowId: z.string().min(1).parse(f.workflowId),
        };
      }
      case "SKILL_GROUP":
        return { groupId: z.string().min(1).parse(f.groupId) };
      case "AUTO_RETRY": {
        const mode = z.enum(["COUNT", "FAILURE"]).parse(f.mode);
        const retryLimit = z
          .number()
          .int()
          .min(1)
          .max(100)
          .nullable()
          .parse(f.retryLimit ?? null);
        if (mode === "COUNT" && retryLimit === null)
          throw new Error("Count-based retry requires a retry limit");
        const targets = z
          .array(
            z.object({
              workflowId: z.string().min(1),
              jobName: z.string().nullable().optional(),
            }),
          )
          .parse(f.targets ?? []);
        const allWorkflows = z.boolean().parse(f.allWorkflows);
        if (!allWorkflows && !targets.length)
          throw new Error("Select at least one GitHub workflow");
        return {
          mode,
          retryLimit,
          allWorkflows,
          failureStrategy: z
            .enum(["FAILED_JOBS", "ALL_JOBS"])
            .parse(f.failureStrategy),
          enabled: false,
          targets,
        };
      }
    }
  }

  async apply(
    input: TransferImportInput,
    expectedFingerprint: string,
    requestId: string,
  ) {
    const prisma = await getPrismaClient();
    const requestHash = fingerprint({ input, expectedFingerprint });
    const previous = await prisma.repositoryTransferOperation.findUnique({
      where: { requestId },
    });
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new Error(
          "This request identifier was used for different selections",
        );
      return this.clones.get(previous.id);
    }
    const review = await this.review(input);
    if (review.preview.fingerprint !== expectedFingerprint)
      throw new Error(
        "The import preview has changed. Review the current settings and destinations again.",
      );
    if (review.preview.blockers.length)
      throw new Error(review.preview.blockers.join("; "));
    const idMap = new Map(
      [...review.resolved.values()].map((v) => [
        v.id,
        v.id.startsWith("planned:") ? randomUUID() : v.id,
      ]),
    );
    for (const d of review.selectedDestinations)
      idMap.set(
        `planned:checkout:${d.repositoryKey}:${d.agentId}`,
        d.codebaseId ?? randomUUID(),
      );
    const actual = (id: string) => idMap.get(id) ?? id;
    const entries = [...review.resolved.values()].map((v) => {
      const fields = structuredClone(v.fields);
      for (const ref of v.entity.references) {
        let current: unknown = fields;
        for (const part of ref.path) {
          if (!current || typeof current !== "object") {
            current = null;
            break;
          }
          current = (current as Record<string, unknown>)[part];
        }
        if (typeof current === "string")
          setReference(fields, ref.path, actual(current));
      }
      return { ...v, id: actual(v.id), fields };
    });
    const byKey = new Map(entries.map((v) => [v.entity.key, v]));
    const repoId = (entry: Resolved) => {
      const id = entry.entity.repositoryKey
        ? byKey.get(entry.entity.repositoryKey)?.id
        : null;
      if (!id)
        throw new Error(
          `Missing destination repository for ${entry.entity.name}`,
        );
      return id;
    };
    const operation = await prisma.$transaction(
      async (tx) => {
        // Check the same database snapshot again under the write transaction.
        for (const [key, candidates] of review.catalog) {
          const [kind, id] = JSON.parse(key) as [string, string | null];
          if (
            fingerprint(await this.candidates(kind, id ?? undefined, tx)) !==
            fingerprint(candidates)
          )
            throw new Error(
              "Settings changed since the preview. Review the import again.",
            );
        }
        for (const e of entries.filter(
          (e) => e.entity.kind === "REPOSITORY" && e.action !== "KEEP",
        )) {
          const data = pick(
            e.fields,
            repositoryFields,
          ) as Prisma.CodebaseRepositoryUncheckedUpdateInput;
          await tx.codebaseRepository.upsert({
            where: { id: e.id },
            create: {
              id: e.id,
              canonicalOrigin: string(e.fields.canonicalOrigin),
              displayOrigin: string(e.fields.canonicalOrigin),
              name: string(e.fields.name) || e.entity.name,
              ...data,
            } as Prisma.CodebaseRepositoryUncheckedCreateInput,
            update: data,
          });
        }
        const app = entries.find((e) => e.entity.kind === "APP");
        if (app && app.action !== "KEEP") {
          const name = string(app.fields.name);
          await tx.app.upsert({
            where: { id: app.id },
            create: {
              id: app.id,
              name,
              normalizedName: normalizedName(name),
              description: string(app.fields.description),
              agentIdsJson: JSON.stringify([
                ...new Set((input.destinations ?? []).map((d) => d.agentId)),
              ]),
            },
            update: {
              name,
              normalizedName: normalizedName(name),
              description: string(app.fields.description),
            },
          });
          for (const id of strings(app.fields.repositoryIds))
            await tx.appRepository.upsert({
              where: {
                appId_repositoryId: { appId: app.id, repositoryId: id },
              },
              create: { appId: app.id, repositoryId: id },
              update: {},
            });
          if (app.existing) {
            const current = await tx.app.findUniqueOrThrow({
              where: { id: app.id },
            });
            const agentIds = [
              ...new Set([
                ...strings(JSON.parse(current.agentIdsJson)),
                ...(input.destinations ?? []).map((d) => d.agentId),
              ]),
            ];
            await tx.app.update({
              where: { id: app.id },
              data: { agentIdsJson: JSON.stringify(agentIds) },
            });
          }
        }
        for (const e of entries) {
          if (e.action === "KEEP") continue;
          const f = e.fields;
          switch (e.entity.kind) {
            case "PREPARATION": {
              const current = await tx.codebaseRepositoryPreparation.findUnique(
                { where: { id: e.id }, include: { statuses: true } },
              );
              if (
                current &&
                (current.kind !== f.kind || current.path !== f.path) &&
                current.statuses.some(
                  (s) => !["UNDONE", "NOT_APPLICABLE"].includes(s.state),
                )
              )
                throw new Error(
                  "Preparation status changed; undo the existing rule before changing its path or kind",
                );
              const contents =
                f.kind === "WRITE"
                  ? decodePreparationContents(string(f.contentBase64))
                  : null;
              const data = {
                kind: string(f.kind),
                path: string(f.path),
                contents: contents ? Uint8Array.from(contents) : null,
                contentSha256: contents
                  ? preparationContentSha256(contents)
                  : null,
                byteCount: contents?.length ?? null,
                definitionHash: preparationDefinitionHash({
                  kind: f.kind as "WRITE" | "DELETE" | "ASSUME_UNCHANGED",
                  path: string(f.path),
                  contents,
                }),
              };
              await tx.codebaseRepositoryPreparation.upsert({
                where: { id: e.id },
                create: { id: e.id, repositoryId: repoId(e), ...data },
                update: data,
              });
              break;
            }
            case "SKILL_GROUP":
              await tx.codebaseRepositorySkillGroup.upsert({
                where: {
                  repositoryId_groupId: {
                    repositoryId: repoId(e),
                    groupId: string(f.groupId),
                  },
                },
                create: { repositoryId: repoId(e), groupId: string(f.groupId) },
                update: {},
              });
              break;
            case "BUILD_CONFIGURATION": {
              const project = await tx.codebaseProject.upsert({
                where: {
                  repositoryId_type: {
                    repositoryId: repoId(e),
                    type: "IOS_APP",
                  },
                },
                create: {
                  id: randomUUID(),
                  repositoryId: repoId(e),
                  type: "IOS_APP",
                },
                update: {},
              });
              const source = await tx.buildSource.upsert({
                where: {
                  projectId_relativePath: {
                    projectId: project.id,
                    relativePath: string(f.sourcePath),
                  },
                },
                create: {
                  id: randomUUID(),
                  projectId: project.id,
                  kind: string(f.sourceKind),
                  relativePath: string(f.sourcePath),
                },
                update: { kind: string(f.sourceKind) },
              });
              const data = {
                ...pick(f, configFields),
                sourceId: source.id,
                advancedSettingsJson: JSON.stringify(f.advancedSettings),
                exportSettingsJson: f.exportSettings
                  ? JSON.stringify(f.exportSettings)
                  : null,
              } as Prisma.BuildConfigurationUncheckedUpdateInput;
              await tx.buildConfiguration.upsert({
                where: { id: e.id },
                create: {
                  id: e.id,
                  projectId: project.id,
                  ...data,
                } as Prisma.BuildConfigurationUncheckedCreateInput,
                update: data,
              });
              break;
            }
            case "BUILD_SCRIPT": {
              const data = pick(
                f,
                scriptFields,
              ) as Prisma.BuildScriptUncheckedUpdateInput;
              await tx.buildScript.upsert({
                where: { id: e.id },
                create: {
                  id: e.id,
                  ...data,
                } as Prisma.BuildScriptUncheckedCreateInput,
                update: data,
              });
              break;
            }
            case "COMMAND": {
              const data = pick(f, [
                ...commandFields,
                "targetAgentId",
              ]) as Prisma.CommandDefinitionUncheckedUpdateInput;
              await tx.commandDefinition.upsert({
                where: { id: e.id },
                create: {
                  id: e.id,
                  ...data,
                } as Prisma.CommandDefinitionUncheckedCreateInput,
                update: data,
              });
              for (const repositoryId of strings(f.targetRepositoryIds))
                await tx.commandDefinitionRepository.upsert({
                  where: {
                    commandId_repositoryId: { commandId: e.id, repositoryId },
                  },
                  create: { commandId: e.id, repositoryId },
                  update: {},
                });
              break;
            }
            case "WORKFLOW": {
              const definition = parseWorkflowDefinition(f.draftDefinition);
              const data = {
                ...pick(f, workflowFields),
                enabled: false,
                draftDefinitionJson: JSON.stringify(definition),
                draftSchemaVersion: definition.schemaVersion,
              } as Prisma.WorkflowUncheckedUpdateInput;
              await tx.workflow.upsert({
                where: { id: e.id },
                create: {
                  id: e.id,
                  ...data,
                } as Prisma.WorkflowUncheckedCreateInput,
                update: data,
              });
              for (const repositoryId of strings(f.repositoryIds))
                await tx.workflowQuickActionRepository.upsert({
                  where: {
                    workflowId_repositoryId: { workflowId: e.id, repositoryId },
                  },
                  create: { workflowId: e.id, repositoryId },
                  update: {},
                });
              break;
            }
            case "AUTO_RETRY": {
              const data = {
                ...pick(f, [
                  "mode",
                  "retryLimit",
                  "allWorkflows",
                  "failureStrategy",
                ]),
                enabled: false,
                status: "PAUSED",
                activatedAt: new Date(),
                lastError: null,
              } as Prisma.GitHubAutoRetryRuleUncheckedUpdateInput;
              await tx.gitHubAutoRetryRule.upsert({
                where: { id: e.id },
                create: {
                  id: e.id,
                  scope: "REPOSITORY",
                  codebaseRepositoryId: repoId(e),
                  ...data,
                } as Prisma.GitHubAutoRetryRuleUncheckedCreateInput,
                update: data,
              });
              await tx.gitHubAutoRetryTarget.deleteMany({
                where: { ruleId: e.id },
              });
              await tx.gitHubAutoRetryExecution.deleteMany({
                where: { ruleId: e.id },
              });
              for (const target of f.targets as {
                workflowId: string;
                jobName?: string | null;
              }[])
                await tx.gitHubAutoRetryTarget.create({
                  data: {
                    id: randomUUID(),
                    ruleId: e.id,
                    workflowId: target.workflowId,
                    jobName: target.jobName ?? null,
                  },
                });
              break;
            }
          }
        }
        // Create exact immutable snapshots only after every owning workflow exists.
        for (const e of entries.filter(
          (e) => e.entity.kind === "WORKFLOW_VERSION" && e.action !== "KEEP",
        )) {
          const definition = parseWorkflowDefinition(e.fields.definition);
          const workflowId = string(e.fields.workflowId);
          const latest = await tx.workflowVersion.findFirst({
            where: { workflowId },
            orderBy: { version: "desc" },
          });
          await tx.workflowVersion.create({
            data: {
              id: e.id,
              workflowId,
              version: (latest?.version ?? 0) + 1,
              name: definition.name,
              description: definition.description,
              schemaVersion: definition.schemaVersion,
              definitionJson: JSON.stringify(definition),
              contentHash: fingerprint(definition),
              triggers: {
                create: definition.triggers.map((t) => ({
                  id: randomUUID(),
                  nodeId: t.id,
                  kind: t.kind,
                  configJson: JSON.stringify(t.config),
                })),
              },
            },
          });
        }
        for (const e of entries.filter(
          (e) => e.entity.kind === "WORKFLOW" && e.action !== "KEEP",
        )) {
          await tx.workflow.update({
            where: { id: e.id },
            data: {
              activeVersionId:
                typeof e.fields.activeVersionId === "string"
                  ? e.fields.activeVersionId
                  : null,
              enabled: (input.enableWorkflowKeys ?? []).includes(e.entity.key),
            },
          });
        }
        // Preserve unlisted scripts and their relative order, following incoming selected scripts.
        const scriptsByRepo = new Map<
          string,
          { id: string; position: number }[]
        >();
        for (const e of entries.filter(
          (e) => e.entity.kind === "BUILD_SCRIPT" && e.action !== "KEEP",
        ))
          for (const link of (e.fields.assignments ?? []) as {
            repositoryId: string;
            position: number;
          }[]) {
            const list = scriptsByRepo.get(link.repositoryId) ?? [];
            list.push({ id: e.id, position: link.position });
            scriptsByRepo.set(link.repositoryId, list);
          }
        for (const [repositoryId, incoming] of scriptsByRepo) {
          const existing = await tx.codebaseRepositoryBuildScript.findMany({
            where: { repositoryId },
            orderBy: { position: "asc" },
          });
          const selected = incoming
            .sort((a, b) => a.position - b.position)
            .map((v) => v.id);
          const order = [
            ...new Set([...selected, ...existing.map((v) => v.scriptId)]),
          ];
          for (const [position, scriptId] of order.entries())
            await tx.codebaseRepositoryBuildScript.upsert({
              where: { repositoryId_scriptId: { repositoryId, scriptId } },
              create: { repositoryId, scriptId, position },
              update: { position },
            });
        }
        const destinations = review.selectedDestinations.map((d) => ({
          ...d,
          repositoryId: byKey.get(d.repositoryKey)!.id,
          codebaseId:
            d.codebaseId ??
            actual(`planned:checkout:${d.repositoryKey}:${d.agentId}`),
        }));
        return this.clones.createOperation(tx, {
          requestId,
          requestHash,
          kind: "IMPORT",
          appId: app?.id,
          result: {
            repositoryIds: entries
              .filter((e) => e.entity.kind === "REPOSITORY")
              .map((e) => e.id),
            importedKeys: entries
              .filter((e) => e.action !== "KEEP")
              .map((e) => e.entity.key),
          },
          destinations,
        });
      },
      { timeout: 30000 },
    );
    await this.publish(entries);
    if (
      entries.some(
        (e) => e.entity.kind === "SKILL_GROUP" && e.action !== "KEEP",
      )
    )
      await this.skills?.requestAutoReconcile();
    return this.clones.dispatch(operation.id);
  }
  private async publish(entries: Resolved[]) {
    const repositories = new Set<string>();
    const entriesByKey = new Map(
      entries.map((entry) => [entry.entity.key, entry]),
    );
    const scripts: string[] = [];
    for (const e of entries) {
      if (e.action === "KEEP") continue;
      if (e.entity.kind === "REPOSITORY") repositories.add(e.id);
      if (e.entity.repositoryKey) {
        const owner = entriesByKey.get(e.entity.repositoryKey);
        if (owner) repositories.add(owner.id);
      }
      if (e.entity.kind === "BUILD_SCRIPT") scripts.push(e.id);
      if (e.entity.kind === "APP")
        agentEventBus.publish("apps.changed", { appsChanged: { id: e.id } });
      if (e.entity.kind === "COMMAND") {
        const definition = await this.commands.getDefinition(e.id);
        if (definition)
          agentEventBus.publish(COMMANDS_CHANGED_TOPIC, {
            commandsChanged: definition,
          });
      }
      if (e.entity.kind === "WORKFLOW")
        agentEventBus.publish("workflows:changed", {
          workflowChanged: { id: e.id },
        });
    }
    if (scripts.length) {
      const prisma = await getPrismaClient();
      const assignments = await prisma.codebaseRepositoryBuildScript.findMany({
        where: { scriptId: { in: scripts } },
        select: { repositoryId: true },
      });
      for (const assignment of assignments)
        repositories.add(assignment.repositoryId);
    }
    for (const repositoryId of repositories)
      agentEventBus.publish(CODEBASE_CHANGED_TOPIC, {
        codebaseOverviewChanged: {
          repositoryId,
          codebaseId: null,
          agentId: null,
        },
      });
    agentEventBus.publish(BUILD_SCRIPTS_CHANGED_TOPIC, {
      buildScriptsChanged: true,
    });
    agentEventBus.publish(SKILLS_CHANGED_TOPIC, { skillsChanged: {} });
  }

  async syncOverview(appId: string) {
    const prisma = await getPrismaClient();
    const app = await prisma.app.findUniqueOrThrow({
      where: { id: appId },
      include: {
        repositories: {
          include: { repository: { include: { codebases: true } } },
        },
      },
    });
    const agents = await this.clones.agents();
    const repositories: SelectionItem[] = app.repositories.map(
      ({ repository: r }) => ({
        key: r.id,
        parentKey: null,
        kind: "REPOSITORY",
        label: r.name,
        repositoryKey: r.id,
        selected: true,
        dependency: false,
        action: "IMPORT",
        targetId: r.id,
        current: null,
        incoming: {
          canonicalOrigin: r.canonicalOrigin,
          remoteUrl: this.cloneUrl(
            r.canonicalOrigin,
            r.codebases[0]?.observedOrigin,
          ),
        },
        affectedRepositories: [],
        candidates: [],
        warnings: [],
      }),
    );
    const destinations = await this.clones.previewDestinations(
      repositories.flatMap((r) =>
        agents.map((a) => ({
          repositoryKey: r.key,
          repositoryId: r.key,
          agentId: a.id,
          remoteUrl: string((r.incoming as Record<string, unknown>).remoteUrl),
        })),
      ),
      { inspect: false },
    );
    const rows = destinations.map((d) => ({
      ...d,
      status:
        d.status === "REUSE"
          ? "PRESENT"
          : d.status === "READY"
            ? "MISSING"
            : "BLOCKED",
    }));
    return {
      appId,
      fingerprint: fingerprint({
        app: app.updatedAt,
        repositories: app.repositories.map((r) => ({
          id: r.repositoryId,
          revision: r.repository.updatedAt,
          codebases: r.repository.codebases.map((c) =>
            pick(c, ["id", "folder", "availability", "updatedAt"]),
          ),
        })),
        agents,
      }),
      selectedAgentIds: strings(JSON.parse(app.agentIdsJson)),
      agents,
      repositories,
      destinations: rows,
    };
  }
  async sync(
    appId: string,
    destinations: TransferDestinationInput[],
    expectedFingerprint: string,
    requestId: string,
  ) {
    const prisma = await getPrismaClient();
    const requestHash = fingerprint({
      appId,
      destinations,
      expectedFingerprint,
    });
    const existing = await prisma.repositoryTransferOperation.findUnique({
      where: { requestId },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new Error("Request identifier was already used");
      return this.clones.get(existing.id);
    }
    const overview = await this.syncOverview(appId);
    if (overview.fingerprint !== expectedFingerprint)
      throw new Error(
        "Repository coverage changed. Refresh Sync and review the destinations again.",
      );
    if (!destinations.length)
      throw new Error("Select at least one missing checkout");
    const selected = destinations.map((d) => {
      const repository = overview.repositories.find(
        (r) => r.key === d.repositoryKey,
      );
      if (!repository)
        throw new Error("Repository does not belong to this app");
      return {
        ...d,
        repositoryId: repository.key,
        remoteUrl:
          d.remoteUrl ||
          string((repository.incoming as Record<string, unknown>).remoteUrl),
      };
    });
    const preview = await this.clones.previewDestinations(selected);
    if (preview.some((d) => d.status === "BLOCKED"))
      throw new Error(
        preview
          .filter((d) => d.error)
          .map((d) => d.error)
          .join("; "),
      );
    const operation = await prisma.$transaction((tx) =>
      this.clones.createOperation(tx, {
        requestId,
        requestHash,
        kind: "SYNC",
        appId,
        destinations: preview,
      }),
    );
    return this.clones.dispatch(operation.id);
  }
}
