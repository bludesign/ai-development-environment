// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  repositoryWorkflows: vi.fn(),
  repositoryWorkflowsForOrigin: vi.fn(),
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));
import { PrismaClient } from "@/generated/prisma/client";
import { CommandsService } from "@/services/commands/commands.service";
import {
  agentEventBus,
  CODEBASE_CHANGED_TOPIC,
  COMMANDS_CHANGED_TOPIC,
} from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import { emptyWorkflowDefinition } from "@/lib/workflows/definition";
import { RepositoryCloneService } from "./clone.service";
import { RepositoryTransferService } from "./repository-transfer.service";
import {
  parseTransferPackage,
  type TransferPackage,
  type TransferImportInput,
} from "./package";

let directory: string,
  template: string,
  counter = 0,
  prisma: PrismaClient,
  service: RepositoryTransferService;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-transfer-"));
  template = join(directory, "template.db");
  const db = new Database(template);
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    for (const dir of readdirSync(resolve("prisma/migrations")).sort()) {
      const file = resolve("prisma/migrations", dir, "migration.sql");
      if (existsSync(file)) db.exec(readFileSync(file, "utf8"));
    }
  })();
  db.close();
}, 120000);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  const path = join(directory, `test-${counter++}.db`);
  await copyFile(template, path);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  mocks.getPrismaClient.mockResolvedValue(prisma);
  mocks.repositoryWorkflows.mockResolvedValue([]);
  mocks.repositoryWorkflowsForOrigin.mockResolvedValue([]);
  await prisma.codebaseRepository.createMany({
    data: [
      {
        id: "source",
        name: "Source",
        canonicalOrigin: "github.com/acme/source",
        displayOrigin: "github.com/acme/source",
        description: "Source settings",
        jiraBranchRegex: "(AIDE-[0-9]+)",
        keepBaseBranchUpToDate: false,
      },
      {
        id: "destination",
        name: "Destination",
        canonicalOrigin: "github.com/acme/destination",
        displayOrigin: "github.com/acme/destination",
        description: "Keep this description",
      },
    ],
  });
  const clones = {
    agents: vi.fn().mockResolvedValue([]),
    previewDestinations: vi.fn().mockResolvedValue([]),
    createOperation: vi.fn(async (tx, input) =>
      tx.repositoryTransferOperation.create({
        data: {
          id: `operation-${input.requestId}`,
          requestId: input.requestId,
          requestHash: input.requestHash,
          kind: input.kind,
          status: "SUCCEEDED",
          appId: input.appId,
          resultJson: JSON.stringify(input.result ?? {}),
        },
        include: { items: true },
      }),
    ),
    dispatch: vi.fn(async (id) =>
      prisma.repositoryTransferOperation.findUnique({
        where: { id },
        include: { items: true },
      }),
    ),
    get: vi.fn(async (id) =>
      prisma.repositoryTransferOperation.findUnique({
        where: { id },
        include: { items: true },
      }),
    ),
  } as unknown as RepositoryCloneService;
  service = new RepositoryTransferService(
    clones,
    {
      normalizeDefinition: CommandsService.prototype.normalizeDefinition,
      getDefinition: CommandsService.prototype.getDefinition,
    } as CommandsService,
    {
      repositoryWorkflows: mocks.repositoryWorkflows,
      repositoryWorkflowsForOrigin: mocks.repositoryWorkflowsForOrigin,
    } as unknown as GitHubService,
  );
});
afterEach(async () => {
  await prisma.$disconnect();
  vi.clearAllMocks();
});
async function input(): Promise<TransferImportInput> {
  return {
    payload: await service.export({ scope: "REPOSITORY", id: "source" }),
    targetRepositoryId: "destination",
  };
}
async function apply(value: TransferImportInput, requestId = "request") {
  const preview = await service.preview(value);
  expect(preview.blockers).toEqual([]);
  return service.apply(value, preview.fingerprint, requestId);
}

describe("portable repository transfers", () => {
  test.each(["automatic", "explicit"] as const)(
    "preserves MCP tool-group IDs with %s server mapping",
    async (mapping) => {
      await prisma.externalMcpServer.create({
        data: {
          id: "source-mcp-server",
          name: "Remote tools",
          url: "https://source.example/mcp",
          transport: "STREAMABLE_HTTP",
        },
      });
      const definition = validPublished("MCP workflow");
      await prisma.workflow.create({
        data: {
          id: "mcp-workflow",
          name: definition.name,
          draftDefinitionJson: JSON.stringify({
            ...definition,
            nodes: definition.nodes.map((node) => ({
              ...node,
              kind: "MCP_CALL",
              config: {
                groupId: "external:source-mcp-server",
                name: "lookup",
                arguments: {},
              },
            })),
          }),
          quickActionRepositories: { create: { repositoryId: "source" } },
        },
      });
      const value = await input();
      const payload = parseTransferPackage(value.payload);
      const reference = payload.entities
        .find((entity) => entity.kind === "WORKFLOW")!
        .references.find((ref) => ref.kind === "MCP_SERVER")!;
      expect(reference.identity).toEqual({ name: "Remote tools" });
      expect(reference.label).toBe("Remote tools");

      await prisma.externalMcpServer.delete({
        where: { id: "source-mcp-server" },
      });
      const destinationName =
        mapping === "automatic" ? "Remote tools" : "Other tools";
      await prisma.externalMcpServer.create({
        data: {
          id: "destination-mcp-server",
          name: destinationName,
          url: "https://destination.example/mcp",
          transport: "STREAMABLE_HTTP",
        },
      });
      if (mapping === "explicit")
        value.mappings = [
          {
            key: reference.key,
            targetId: "external:destination-mcp-server",
          },
        ];
      const preview = await service.preview(value);
      expect(preview.blockers).toEqual([]);
      expect(
        preview.dependencies.find(
          (dependency) => dependency.key === reference.key,
        ),
      ).toMatchObject({
        resolved: true,
        targetId: "external:destination-mcp-server",
        candidates: [
          { id: "external:destination-mcp-server", label: destinationName },
        ],
      });
      await service.apply(value, preview.fingerprint, `mcp-${mapping}`);
      const imported = await prisma.workflow.findUniqueOrThrow({
        where: { id: "mcp-workflow" },
      });
      expect(JSON.parse(imported.draftDefinitionJson).nodes[0].config).toEqual({
        groupId: "external:destination-mcp-server",
        name: "lookup",
        arguments: {},
      });
    },
  );

  test("previews without writes and imports selected settings without changing target identity", async () => {
    const value = await input();
    value.excludedKeys = ["repository:source/field/description"];
    const preview = await service.preview(value);
    expect(preview.blockers).toEqual([]);
    expect(
      (
        await prisma.codebaseRepository.findUniqueOrThrow({
          where: { id: "destination" },
        })
      ).name,
    ).toBe("Destination");
    await service.apply(value, preview.fingerprint, "request");
    expect(
      await prisma.codebaseRepository.findUnique({
        where: { id: "destination" },
      }),
    ).toMatchObject({
      name: "Source",
      description: "Keep this description",
      canonicalOrigin: "github.com/acme/destination",
      jiraBranchRegex: "(AIDE-[0-9]+)",
      keepBaseBranchUpToDate: false,
    });
  });
  test("stale previews reject changed configuration before any writes", async () => {
    const value = await input();
    const preview = await service.preview(value);
    await prisma.codebaseRepository.update({
      where: { id: "destination" },
      data: { description: "Concurrent edit" },
    });
    await expect(
      service.apply(value, preview.fingerprint, "request"),
    ).rejects.toThrow("preview has changed");
    expect(await prisma.repositoryTransferOperation.count()).toBe(0);
  });
  test("blocks a published snapshot whose static condition pattern cannot execute", async () => {
    const original = validPublished("Invalid pattern");
    const definition = {
      ...original,
      nodes: original.nodes.map((node) => ({
        ...node,
        config: { condition: { op: "MATCHES", left: "text", right: "[" } },
      })),
    };
    await prisma.workflow.create({
      data: {
        id: "invalid-pattern-workflow",
        name: definition.name,
        draftDefinitionJson: JSON.stringify(definition),
        quickActionRepositories: { create: { repositoryId: "source" } },
      },
    });
    await prisma.workflowVersion.create({
      data: {
        id: "invalid-pattern-version",
        workflowId: "invalid-pattern-workflow",
        version: 1,
        name: definition.name,
        definitionJson: JSON.stringify(definition),
        contentHash: "invalid-pattern",
      },
    });
    await prisma.workflow.update({
      where: { id: "invalid-pattern-workflow" },
      data: { activeVersionId: "invalid-pattern-version" },
    });
    const value = await input();
    value.enableWorkflowKeys = ["workflow:invalid-pattern-workflow"];
    const preview = await service.preview(value);
    expect(preview.blockers.join(" ")).toMatch(/condition pattern/i);
    expect(await prisma.repositoryTransferOperation.count()).toBe(0);
  });
  test("idempotent apply returns the original operation and rejects changed input", async () => {
    const value = await input();
    const preview = await service.preview(value);
    const first = await service.apply(value, preview.fingerprint, "request");
    const second = await service.apply(value, preview.fingerprint, "request");
    expect(second?.id).toBe(first?.id);
    expect(await prisma.repositoryTransferOperation.count()).toBe(1);
    await expect(
      service.apply(
        { ...value, excludedKeys: ["repository:source/field/name"] },
        preview.fingerprint,
        "request",
      ),
    ).rejects.toThrow("different selections");
  });
  test("previews imported-name collisions when explicitly targeting another build script", async () => {
    await prisma.buildScript.createMany({
      data: [
        {
          id: "source-script",
          name: "Build setup",
          preBuildScript: "echo source",
        },
        {
          id: "other-script",
          name: "Other setup",
          preBuildScript: "echo other",
        },
      ],
    });
    await prisma.codebaseRepositoryBuildScript.create({
      data: { repositoryId: "source", scriptId: "source-script", position: 0 },
    });
    const value = await input();
    value.choices = [
      {
        key: "build_script:source-script",
        action: "IMPORT",
        targetId: "other-script",
      },
    ];
    const collision = await service.preview(value);
    expect(collision.blockers.join(" ")).toContain(
      "another item already uses this name",
    );
    await expect(
      service.apply(value, collision.fingerprint, "collision"),
    ).rejects.toThrow("another item already uses this name");
    expect(await prisma.repositoryTransferOperation.count()).toBe(0);
    expect(
      await prisma.buildScript.findUnique({ where: { id: "other-script" } }),
    ).toMatchObject({ name: "Other setup", preBuildScript: "echo other" });

    value.choices[0]!.action = "KEEP";
    expect((await service.preview(value)).blockers).toEqual([]);
    value.choices[0] = {
      key: "build_script:source-script",
      action: "IMPORT",
      targetId: "source-script",
    };
    expect((await service.preview(value)).blockers).toEqual([]);
  });
  test("blocks deleted script names, invalidates stale reservations, and permits a uniquely named copy", async () => {
    await prisma.buildScript.create({
      data: {
        id: "reserved-script",
        name: "Build setup",
        preBuildScript: "echo source",
        repositories: { create: { repositoryId: "source", position: 0 } },
      },
    });
    const value = await input();
    await prisma.codebaseRepositoryBuildScript.deleteMany({
      where: { scriptId: "reserved-script" },
    });
    await prisma.buildScript.update({
      where: { id: "reserved-script" },
      data: { deletedAt: new Date() },
    });
    const blocked = await service.preview(value);
    expect(blocked.blockers.join(" ")).toContain(
      "this name belongs to a deleted build script",
    );
    await expect(
      service.apply(value, blocked.fingerprint, "reserved-name"),
    ).rejects.toThrow("deleted build script");
    expect(await prisma.repositoryTransferOperation.count()).toBe(0);

    value.choices = [
      {
        key: "build_script:reserved-script",
        action: "COPY",
        name: "Fresh build setup",
      },
    ];
    const reviewed = await service.preview(value);
    expect(reviewed.blockers).toEqual([]);
    await prisma.buildScript.update({
      where: { id: "reserved-script" },
      data: { name: "Fresh build setup" },
    });
    await expect(
      service.apply(value, reviewed.fingerprint, "stale-reservation"),
    ).rejects.toThrow("preview has changed");

    value.choices[0]!.name = "Unique build setup";
    await apply(value, "unique-copy");
    expect(
      await prisma.buildScript.findUnique({ where: { id: "reserved-script" } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await prisma.buildScript.findUnique({
        where: { name: "Unique build setup" },
      }),
    ).toMatchObject({ deletedAt: null, preBuildScript: "echo source" });
  });
  test("round trips binary preparations and preserves unlisted destination preparations", async () => {
    await prisma.codebaseRepositoryPreparation.createMany({
      data: [
        {
          id: "source-prep",
          repositoryId: "source",
          kind: "WRITE",
          path: "config.bin",
          contents: Uint8Array.from([0, 1, 255, 128]),
          byteCount: 4,
          definitionHash: "source",
        },
        {
          id: "destination-prep",
          repositoryId: "destination",
          kind: "DELETE",
          path: "obsolete.txt",
          definitionHash: "destination",
        },
      ],
    });
    const publish = vi.spyOn(agentEventBus, "publish");
    const value = await input();
    value.choices = [{ key: "repository:source", action: "KEEP" }];
    await apply(value);
    const rows = await prisma.codebaseRepositoryPreparation.findMany({
      where: { repositoryId: "destination" },
    });
    expect(rows).toHaveLength(2);
    expect(
      Buffer.from(rows.find((r) => r.path === "config.bin")!.contents!),
    ).toEqual(Buffer.from([0, 1, 255, 128]));
    expect(publish).toHaveBeenCalledWith(CODEBASE_CHANGED_TOPIC, {
      codebaseOverviewChanged: {
        repositoryId: "destination",
        codebaseId: null,
        agentId: null,
      },
    });
  });
  test("selected repository commands retain outside assignments and remap template root", async () => {
    const publish = vi.spyOn(agentEventBus, "publish");
    await prisma.codebaseRepository.create({
      data: {
        id: "outside",
        name: "Outside",
        canonicalOrigin: "github.com/acme/outside",
        displayOrigin: "github.com/acme/outside",
      },
    });
    await prisma.commandDefinition.create({
      data: {
        id: "command",
        name: "Tests",
        script: "npm test",
        targetKind: "REPOSITORY_WORKTREE",
        repositories: {
          create: [{ repositoryId: "source" }, { repositoryId: "outside" }],
        },
      },
    });
    const value = await input();
    const pack = parseTransferPackage(value.payload);
    expect(pack.entities.find((e) => e.kind === "COMMAND")).toBeDefined();
    expect(
      pack.entities.some(
        (e) => e.kind === "REPOSITORY" && e.name === "Outside",
      ),
    ).toBe(false);
    await apply(value);
    const assignments = await prisma.commandDefinitionRepository.findMany({
      where: { commandId: "command" },
    });
    expect(assignments.map((r) => r.repositoryId).sort()).toEqual([
      "destination",
      "outside",
      "source",
    ]);
    expect(publish).toHaveBeenCalledWith(COMMANDS_CHANGED_TOPIC, {
      commandsChanged: expect.objectContaining({
        id: "command",
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        targetRepositoryIds: expect.arrayContaining([
          "destination",
          "outside",
          "source",
        ]),
        targetRepositories: expect.arrayContaining([
          expect.objectContaining({ id: "destination" }),
        ]),
      }),
    });
  });
  test("unresolved targets block instead of widening command scope", async () => {
    const value = await input();
    const pack = value.payload as TransferPackage;
    pack.entities.push({
      key: "command:missing",
      kind: "COMMAND",
      name: "Missing target",
      dependency: false,
      fields: {
        name: "Missing target",
        description: "",
        script: "echo test",
        targetKind: "REPOSITORY_WORKTREE",
        targetRepositoryIds: [null],
      },
      references: [
        {
          key: "missing-reference",
          kind: "REPOSITORY",
          label: "Missing repository",
          path: ["targetRepositoryIds", 0],
          identity: { canonicalOrigin: "github.com/acme/absent" },
        },
      ],
    });
    const preview = await service.preview(value);
    expect(preview.dependencies[0]?.resolved).toBe(false);
    expect(preview.blockers.join(" ")).toContain("Missing repository");
    expect(await prisma.commandDefinition.count()).toBe(0);
  });
  test("imports workflows disabled, preserves the distinct draft and existing history", async () => {
    const definition = emptyWorkflowDefinition("Review");
    await prisma.workflow.create({
      data: {
        id: "workflow",
        name: "Review",
        enabled: true,
        draftDefinitionJson: JSON.stringify(definition),
        quickActionKind: "STANDARD",
        quickActionRepositories: { create: { repositoryId: "source" } },
      },
    });
    const value = await input();
    await apply(value);
    expect(
      await prisma.workflow.findUnique({ where: { id: "workflow" } }),
    ).toMatchObject({ enabled: false });
    expect(
      await prisma.workflowQuickActionRepository.findMany({
        where: { workflowId: "workflow" },
      }),
    ).toHaveLength(2);
  });
  test("invalid package versions and duplicated identities fail before changes", async () => {
    const value = await input();
    await expect(
      service.preview({
        ...value,
        payload: { ...(value.payload as object), version: 99 },
      }),
    ).rejects.toThrow();
    const pack = value.payload as TransferPackage;
    pack.entities.push(pack.entities[0]);
    await expect(service.preview(value)).rejects.toThrow("duplicate item");
  });
  test("ambiguous command matches require an explicit choice", async () => {
    await prisma.commandDefinition.createMany({
      data: [
        {
          id: "a",
          name: "Same",
          script: "echo a",
          targetKind: "ANY_AGENT_HOME",
        },
        {
          id: "b",
          name: "Same",
          script: "echo b",
          targetKind: "ANY_AGENT_HOME",
        },
      ],
    });
    const value = await input();
    (value.payload as TransferPackage).entities.push({
      key: "incoming",
      kind: "COMMAND",
      name: "Same",
      dependency: false,
      fields: {
        name: "Same",
        script: "echo imported",
        targetKind: "ANY_AGENT_HOME",
      },
      references: [],
    });
    expect((await service.preview(value)).blockers.join(" ")).toContain(
      "multiple matching",
    );
    value.choices = [{ key: "incoming", action: "IMPORT", targetId: "b" }];
    await apply(value);
    expect(
      (await prisma.commandDefinition.findUniqueOrThrow({ where: { id: "a" } }))
        .script,
    ).toBe("echo a");
    expect(
      (await prisma.commandDefinition.findUniqueOrThrow({ where: { id: "b" } }))
        .script,
    ).toBe("echo imported");
  });
});

describe("complete repository settings", () => {
  test("imports iOS configuration by relative source without requiring a checkout", async () => {
    await prisma.codebaseProject.create({
      data: {
        id: "project",
        repositoryId: "source",
        type: "IOS_APP",
        sources: {
          create: {
            id: "build-source",
            kind: "PROJECT",
            relativePath: "Mobile.xcodeproj",
          },
        },
        configurations: {
          create: {
            id: "configuration",
            sourceId: "build-source",
            name: "Debug",
            scheme: "Mobile",
            buildConfiguration: "Debug",
            defaultAction: "BUILD",
            advancedSettingsJson: "{}",
          },
        },
      },
    });
    await apply(await input());
    const project = await prisma.codebaseProject.findUnique({
      where: {
        repositoryId_type: { repositoryId: "destination", type: "IOS_APP" },
      },
      include: { configurations: { include: { source: true } } },
    });
    expect(project?.configurations[0]).toMatchObject({
      name: "Debug",
      scheme: "Mobile",
      source: { relativePath: "Mobile.xcodeproj" },
    });
    expect(await prisma.codebase.count()).toBe(0);
  });
  test("maps skill groups, imports paused retry rules, and preserves unlisted scripts", async () => {
    await prisma.skillGroup.create({
      data: {
        id: "group",
        name: "Shared skills",
        repositories: { create: { repositoryId: "source" } },
      },
    });
    await prisma.buildScript.createMany({
      data: [
        {
          id: "incoming-script",
          name: "Build setup",
          preBuildScript: "echo setup",
        },
        {
          id: "untouched-script",
          name: "Local setup",
          preBuildScript: "echo local",
        },
      ],
    });
    await prisma.codebaseRepositoryBuildScript.createMany({
      data: [
        { repositoryId: "source", scriptId: "incoming-script", position: 0 },
        {
          repositoryId: "destination",
          scriptId: "untouched-script",
          position: 0,
        },
      ],
    });
    await prisma.gitHubAutoRetryRule.create({
      data: {
        id: "retry",
        scope: "REPOSITORY",
        codebaseRepositoryId: "source",
        allWorkflows: true,
        mode: "COUNT",
        retryLimit: 2,
      },
    });
    await apply(await input());
    expect(
      await prisma.codebaseRepositorySkillGroup.findMany({
        where: { repositoryId: "destination" },
      }),
    ).toMatchObject([{ groupId: "group" }]);
    expect(
      await prisma.gitHubAutoRetryRule.findFirst({
        where: { codebaseRepositoryId: "destination" },
      }),
    ).toMatchObject({ enabled: false, status: "PAUSED", retryLimit: 2 });
    expect(
      (
        await prisma.codebaseRepositoryBuildScript.findMany({
          where: { repositoryId: "destination" },
          orderBy: { position: "asc" },
        })
      ).map((r) => r.scriptId),
    ).toEqual(["incoming-script", "untouched-script"]);
  });
  test("keeps exact published snapshot separate from unpublished draft and retains history", async () => {
    const draft = emptyWorkflowDefinition("Draft changes");
    const published = validPublished("Published behavior");
    await prisma.workflow.create({
      data: {
        id: "workflow",
        name: "Draft changes",
        draftDefinitionJson: JSON.stringify(draft),
        quickActionRepositories: { create: { repositoryId: "source" } },
      },
    });
    await prisma.workflowVersion.create({
      data: {
        id: "version",
        workflowId: "workflow",
        version: 1,
        name: published.name,
        definitionJson: JSON.stringify(published),
        contentHash: "original",
      },
    });
    await prisma.workflow.update({
      where: { id: "workflow" },
      data: { activeVersionId: "version", enabled: true },
    });
    await apply(await input());
    const workflow = await prisma.workflow.findUniqueOrThrow({
      where: { id: "workflow" },
      include: { versions: true, activeVersion: true },
    });
    expect(workflow.versions).toHaveLength(2);
    expect(workflow.activeVersion?.id).not.toBe("version");
    expect(JSON.parse(workflow.activeVersion!.definitionJson).name).toBe(
      "Published behavior",
    );
    expect(JSON.parse(workflow.draftDefinitionJson).name).toBe("Draft changes");
    expect(workflow.enabled).toBe(false);
  });
  test("draft-only export preserves the destination published version", async () => {
    const definition = emptyWorkflowDefinition("Workflow");
    await prisma.workflow.create({
      data: {
        id: "workflow",
        name: "Workflow",
        draftDefinitionJson: JSON.stringify(definition),
        quickActionRepositories: { create: { repositoryId: "source" } },
      },
    });
    await prisma.workflowVersion.create({
      data: {
        id: "version",
        workflowId: "workflow",
        version: 1,
        name: "Published",
        definitionJson: JSON.stringify(definition),
        contentHash: "original",
      },
    });
    await prisma.workflow.update({
      where: { id: "workflow" },
      data: { activeVersionId: "version" },
    });
    const payload = await service.export({
      scope: "REPOSITORY",
      id: "source",
      excludedKeys: ["workflow_version:version"],
    });
    expect(payload.entities.some((e) => e.kind === "WORKFLOW_VERSION")).toBe(
      false,
    );
    await apply({ payload, targetRepositoryId: "destination" });
    expect(
      (await prisma.workflow.findUniqueOrThrow({ where: { id: "workflow" } }))
        .activeVersionId,
    ).toBe("version");
    expect(await prisma.workflowVersion.count()).toBe(1);
  });
  test("rejects mismatched reference kinds and missing portable metadata", async () => {
    const value = await input();
    const pack = value.payload as TransferPackage;
    pack.entities.push({
      key: "command:bad",
      kind: "COMMAND",
      name: "Bad",
      dependency: false,
      fields: {
        name: "Bad",
        script: "echo x",
        targetKind: "SPECIFIC_AGENT_HOME",
        targetAgentId: null,
      },
      references: [
        {
          key: "wrong",
          kind: "AGENT",
          path: ["targetAgentId"],
          label: "Agent",
          entityKey: "repository:source",
          identity: {},
        },
      ],
    });
    await expect(service.preview(value)).rejects.toThrow("wrong resource kind");
    pack.entities.at(-1)!.references = [];
    pack.entities.at(-1)!.fields.targetAgentId = "unportable-source-id";
    await expect(service.preview(value)).rejects.toThrow(
      "missing portable reference",
    );
  });
  test("maps GitHub Actions paths to a template destination and an unregistered origin", async () => {
    const workflow = {
      id: "source-action",
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
      url: "https://github.com/acme/source/actions",
      jobNames: [],
    };
    mocks.repositoryWorkflows.mockImplementation(async (id: string) => [
      {
        ...workflow,
        id: id === "source" ? "source-action" : "destination-action",
      },
    ]);
    mocks.repositoryWorkflowsForOrigin.mockResolvedValue([
      { ...workflow, id: "fresh-action" },
    ]);
    await prisma.gitHubAutoRetryRule.create({
      data: {
        id: "path-retry",
        scope: "REPOSITORY",
        codebaseRepositoryId: "source",
        allWorkflows: false,
        mode: "COUNT",
        retryLimit: 2,
        targets: {
          create: { id: "source-target", workflowId: "source-action" },
        },
      },
    });
    const payload = await service.export({ scope: "REPOSITORY", id: "source" });
    await apply(
      { payload, targetRepositoryId: "destination" },
      "template-actions",
    );
    const rule = await prisma.gitHubAutoRetryRule.findFirstOrThrow({
      where: { codebaseRepositoryId: "destination" },
      include: { targets: true },
    });
    expect(rule.targets.map((t) => t.workflowId)).toEqual([
      "destination-action",
    ]);
    expect(rule.enabled).toBe(false);
    await prisma.codebaseRepository.delete({ where: { id: "source" } });
    await apply({ payload }, "fresh-actions");
    expect(mocks.repositoryWorkflowsForOrigin).toHaveBeenCalledWith(
      "github.com/acme/source",
    );
    const repository = await prisma.codebaseRepository.findUniqueOrThrow({
      where: { canonicalOrigin: "github.com/acme/source" },
    });
    const fresh = await prisma.gitHubAutoRetryRule.findFirstOrThrow({
      where: { codebaseRepositoryId: repository.id },
      include: { targets: true },
    });
    expect(fresh.targets.map((t) => t.workflowId)).toEqual(["fresh-action"]);
  });
  test("app repository exclusion does not add the excluded membership", async () => {
    await prisma.app.create({
      data: {
        id: "app",
        name: "App",
        normalizedName: "app",
        repositories: {
          create: [{ repositoryId: "source" }, { repositoryId: "destination" }],
        },
      },
    });
    const payload = await service.export({
      scope: "APP",
      id: "app",
      excludedKeys: ["repository:destination"],
    });
    const app = payload.entities.find((e) => e.kind === "APP")!;
    expect(app.fields.repositoryIds).toHaveLength(1);
    expect(app.references.map((r) => r.entityKey)).toEqual([
      "repository:source",
    ]);
  });

  describe("import destination coverage", () => {
    beforeEach(async () => {
      await prisma.agent.createMany({
        data: ["present", "missing", "offline"].map((id) => ({
          id,
          name: id,
          hostname: id,
          version: "test",
          osVersion: "test",
          architecture: "arm64",
          capabilitiesJson: '["codebase.clone","codebase.clone.inspect"]',
          secretHash: id,
          baseRepoDirectory: "/base",
          lastSeenAt: id === "offline" ? null : new Date(),
        })),
      });
      await prisma.codebase.createMany({
        data: ["source", "destination"].map((repositoryId) => ({
          id: `checkout-${repositoryId}`,
          agentId: "present",
          repositoryId,
          folder: `/custom/workspaces/${repositoryId}`,
          observedOrigin: `git@github.com:acme/${repositoryId}.git`,
        })),
      });
      await prisma.app.create({
        data: {
          id: "app",
          name: "App",
          normalizedName: "app",
          repositories: {
            create: [
              { repositoryId: "source" },
              { repositoryId: "destination" },
            ],
          },
        },
      });
      vi.mocked(service.clones.agents).mockImplementation(
        RepositoryCloneService.prototype.agents.bind(service.clones),
      );
      // Use real persisted checkout lookup; on-agent inspection is tested in
      // clone.service.test.ts and unavailable in this database-only fixture.
      vi.mocked(service.clones.previewDestinations).mockImplementation(
        (destinations) =>
          RepositoryCloneService.prototype.previewDestinations.call(
            service.clones,
            destinations,
            { inspect: false },
          ),
      );
      vi.mocked(service.clones.createOperation).mockImplementation(
        RepositoryCloneService.prototype.createOperation.bind(service.clones),
      );
    });

    test("shows all agents' registered checkouts before selecting destinations", async () => {
      const payload = await service.export({ scope: "APP", id: "app" });
      const preview = await service.preview({ payload });
      expect(preview.destinations).toHaveLength(6);
      expect(
        preview.destinations.filter((d) => d.agentId === "present"),
      ).toEqual(
        expect.arrayContaining(
          ["source", "destination"].map((id) =>
            expect.objectContaining({
              repositoryKey: `repository:${id}`,
              repositoryId: id,
              status: "REUSE",
              codebaseId: `checkout-${id}`,
              destinationPath: `/custom/workspaces/${id}`,
            }),
          ),
        ),
      );
      expect(
        preview.destinations.filter((d) => d.agentId === "missing"),
      ).toEqual([
        expect.objectContaining({ status: "READY" }),
        expect.objectContaining({ status: "READY" }),
      ]);
      expect(
        preview.destinations.filter((d) => d.agentId === "offline"),
      ).toEqual([
        expect.objectContaining({
          status: "BLOCKED",
          error: "Agent is offline",
        }),
        expect.objectContaining({
          status: "BLOCKED",
          error: "Agent is offline",
        }),
      ]);
      expect(preview.blockers).toEqual([
        "Select at least one destination agent for this app",
      ]);
      expect(service.clones.previewDestinations).toHaveBeenNthCalledWith(1, []);
      expect(service.clones.previewDestinations).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        { inspect: false },
      );
      expect(await prisma.agentJob.count()).toBe(0);
    });

    test("imports to an agent with every checkout and does not clone unselected coverage", async () => {
      const payload = await service.export({ scope: "APP", id: "app" });
      const destinations = ["source", "destination"].map((id) => ({
        repositoryKey: `repository:${id}`,
        agentId: "present",
      }));
      const value = { payload, destinations };
      const preview = await service.preview(value);
      expect(preview.blockers).toEqual([]);
      expect(preview.destinations).toHaveLength(6);
      await service.apply(value, preview.fingerprint, "existing-checkouts");
      const operation =
        await prisma.repositoryTransferOperation.findUniqueOrThrow({
          where: { requestId: "existing-checkouts" },
          include: { items: true },
        });
      expect(operation.items).toHaveLength(2);
      expect(operation.items).toEqual(
        expect.arrayContaining(
          ["source", "destination"].map((id) =>
            expect.objectContaining({
              repositoryId: id,
              agentId: "present",
              status: "REUSED",
              codebaseId: `checkout-${id}`,
              destinationPath: `/custom/workspaces/${id}`,
            }),
          ),
        ),
      );
      expect(await prisma.codebase.count()).toBe(2);
      expect(await prisma.agentJob.count()).toBe(0);
      expect(
        JSON.parse(
          (await prisma.app.findUniqueOrThrow({ where: { id: "app" } }))
            .agentIdsJson,
        ),
      ).toEqual(["present"]);
    });

    test("repository settings can import without selecting any clone destinations", async () => {
      await apply(await input(), "settings-only");
      expect(service.clones.createOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ destinations: [] }),
      );
      expect(await prisma.repositoryTransferItem.count()).toBe(0);
      expect(await prisma.codebase.count()).toBe(2);
    });
  });
});

function validPublished(name: string) {
  const definition = emptyWorkflowDefinition(name);
  return {
    ...definition,
    nodes: [
      {
        id: "load",
        kind: "JIRA_LOAD_TICKET" as const,
        name: "Load",
        position: { x: 200, y: 100 },
        config: {},
        requiredPaths: [],
        providedPaths: [],
        retry: {
          maxAttempts: 1,
          strategy: "EXPONENTIAL" as const,
          delaySeconds: 5,
        },
        failurePolicy: "FAIL" as const,
      },
    ],
    edges: [
      {
        id: "start-load",
        source: "manual",
        target: "load",
        sourceHandle: "success",
        targetHandle: "input",
      },
    ],
  };
}
