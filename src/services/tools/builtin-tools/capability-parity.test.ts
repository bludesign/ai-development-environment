import { describe, expect, test, vi } from "vitest";
import * as z from "zod/v4";
import type { BuiltInToolGroup } from "../builtin-tools";
import {
  createActionCenterToolGroup,
  createAppsToolGroup,
  createCliHealthToolGroup,
} from "./discovery";
import { createCrashToolGroup } from "./crashes";
import { createRunToolGroup } from "./runs";
import { createCommandToolGroup } from "./commands";
import { createBuildToolGroup } from "./builds";
import { createRepositoryTransferToolGroup } from "./repository-transfer";

const now = new Date("2026-10-28T12:00:00Z");
const tool = (group: BuiltInToolGroup, name: string) => {
  const result = group.tools.find((entry) => entry.name === name);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
};
const runInput = {
  kind: "PLAN",
  worktreeId: "wt",
  provider: "CODEX",
  model: "model",
  prompt: "Do work",
};
const draft = {
  id: "draft",
  kind: "PLAN",
  worktreeId: "wt",
  agentId: "agent",
  jiraIssueKey: null,
  provider: "CODEX",
  model: "model",
  effort: null,
  webSearchEnabled: true,
  mcpPresetIdsJson: '["preset"]',
  prompt: "Do work",
  attachments: [
    {
      id: "attachment",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 10,
      sha256: "digest",
      createdAt: now,
      storagePath: "/private/secret",
    },
  ],
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
  worktree: { agent: { secret: "secret" } },
};
const upload = {
  id: "upload",
  filename: "symbols.zip",
  status: "FAILED",
  error: "Retry",
  source: "BUILD",
  buildId: "build",
  linkedBuildId: "build",
  projectName: "App",
  sizeBytes: 100,
  uploadOffset: 100,
  attempts: 1,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  ownerKey: "secret",
  apiKeyId: "secret",
  stagingPath: "/private/secret",
  storageDirectory: "/private/secret",
  url: "https://example.com?token=secret",
};

describe("MCP capability parity", () => {
  test("forwards Action Center fingerprints and projects settings", async () => {
    const settings = {
      maximumRequestAgeDays: 30,
      showMyRequestsInSidebar: true,
      showReviewRequestsInSidebar: false,
    };
    const service = {
      settings: vi.fn().mockResolvedValue({ ...settings, internal: "secret" }),
      saveSettings: vi.fn().mockResolvedValue(settings),
      refresh: vi.fn().mockResolvedValue(true),
      acknowledge: vi.fn().mockResolvedValue(true),
      dismiss: vi.fn().mockResolvedValue(true),
    };
    const group = createActionCenterToolGroup(service as never);
    expect(await tool(group, "get_action_center_settings").invoke({})).toEqual({
      settings,
    });
    await tool(group, "save_action_center_settings").invoke({
      input: settings,
    });
    expect(service.saveSettings).toHaveBeenCalledWith(settings);
    const failure = {
      resourceKind: "BUILD",
      resourceId: "build",
      failureFingerprint: "generation:1",
    };
    await tool(group, "acknowledge_action_center_item").invoke(failure);
    expect(service.acknowledge).toHaveBeenCalledWith(failure);
    const dismissal = {
      resourceKind: "PULL_REQUEST",
      resourceId: "pr",
      dismissalFingerprint: "sha:1",
    };
    await tool(group, "dismiss_action_center_item").invoke(dismissal);
    expect(service.dismiss).toHaveBeenCalledWith(dismissal);
    expect(await tool(group, "refresh_action_center").invoke({})).toEqual({
      refreshed: true,
    });
    await expect(
      tool(group, "acknowledge_action_center_item").invoke({
        ...failure,
        failureFingerprint: "",
      }),
    ).rejects.toThrow();
    expect(service.acknowledge).toHaveBeenCalledTimes(1);
  });

  test("writes app memberships without exposing nested agent data", async () => {
    const counts = {
      repositories: 1,
      codebases: 1,
      worktrees: 0,
      dirtyWorktrees: 0,
      nonMainWorktrees: 0,
      openRequests: 0,
      plans: 0,
      sessions: 0,
      builds: 0,
    };
    const app = {
      id: "app",
      name: "App",
      description: "",
      agentIds: ["agent"],
      repositories: [
        {
          id: "repo",
          name: "Repo",
          description: "",
          agent: { token: "secret" },
        },
      ],
      counts,
      createdAt: now,
      updatedAt: now,
    };
    const service = {
      create: vi.fn().mockResolvedValue(app),
      update: vi.fn().mockResolvedValue(app),
      delete: vi.fn().mockResolvedValue({ id: "app" }),
    };
    const group = createAppsToolGroup(service as never);
    const input = { name: "App", repositoryIds: ["repo"], agentIds: ["agent"] };
    const result = await tool(group, "create_app").invoke(input);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(service.create).toHaveBeenCalledWith(input);
    await tool(group, "update_app").invoke({ ...input, id: "app" });
    expect(service.update).toHaveBeenCalledWith({ ...input, id: "app" });
    await tool(group, "delete_app").invoke({ id: "app" });
    expect(service.delete).toHaveBeenCalledWith("app");
    expect(tool(group, "delete_app").annotations.destructiveHint).toBe(true);
    await expect(
      tool(group, "create_app").invoke({ name: "App", repositoryIds: [] }),
    ).rejects.toThrow();
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  test("executes CLI checks only through annotated writes and bounds definitions", async () => {
    const status = {
      version: "1",
      dependencies: [],
      customChecks: [],
      agents: [],
    };
    const service = {
      run: vi.fn().mockResolvedValue(status),
      saveSettings: vi.fn().mockResolvedValue(status),
    };
    const group = createCliHealthToolGroup(service as never);
    await tool(group, "run_cli_health_checks").invoke({ agentId: "agent" });
    expect(service.run).toHaveBeenCalledWith("agent");
    const checks = [
      { name: "CLI", command: "command --version", enabled: true },
    ];
    await tool(group, "save_cli_health_settings").invoke({ checks });
    expect(service.saveSettings).toHaveBeenCalledWith(checks);
    await expect(
      tool(group, "save_cli_health_settings").invoke({
        checks: Array.from({ length: 21 }, () => checks[0]),
      }),
    ).rejects.toThrow();
    expect(service.saveSettings).toHaveBeenCalledTimes(1);
    expect(tool(group, "run_cli_health_checks").annotations.readOnlyHint).toBe(
      false,
    );
    expect(
      tool(group, "save_cli_health_settings").annotations.destructiveHint,
    ).toBe(true);
  });

  test("manages dSYM jobs without exposing upload ownership or paths", async () => {
    const settings = {
      collectionEnabled: true,
      symbolicationAgentId: null,
      retentionDays: 30,
      dsymRetentionDays: null,
    };
    const service = {
      dsymUploads: vi.fn().mockResolvedValue([upload]),
      updateDsymUpload: vi.fn().mockResolvedValue(upload),
      retryDsymUpload: vi.fn().mockResolvedValue(upload),
      deleteDsymUpload: vi.fn().mockResolvedValue(true),
      deleteCrashReports: vi.fn().mockResolvedValue(1),
      deleteDsyms: vi.fn().mockResolvedValue(2),
      settings: vi.fn().mockResolvedValue({
        ...settings,
        symbolicationAgent: { secret: "secret" },
      }),
      updateSettings: vi.fn().mockResolvedValue(settings),
      symbolicationAgents: vi.fn().mockResolvedValue([
        {
          id: "agent",
          name: "Mac",
          hostname: "host",
          online: true,
          enrollmentToken: "secret",
        },
      ]),
      crashFacets: vi.fn().mockResolvedValue({ apps: [], appVersions: [] }),
      dsymProjects: vi.fn().mockResolvedValue(["App"]),
      symbolicate: vi.fn().mockResolvedValue(null),
    };
    const group = createCrashToolGroup(service as never);
    const uploads = await tool(group, "get_dsym_uploads").invoke({
      statuses: ["FAILED"],
    });
    expect(service.dsymUploads).toHaveBeenCalledWith(["FAILED"]);
    expect(JSON.stringify(uploads)).not.toContain("secret");
    const metadata = {
      buildId: "build",
      projectName: "App",
      url: "https://example.com/build",
    };
    await tool(group, "update_dsym_upload").invoke({
      id: "upload",
      input: metadata,
    });
    expect(service.updateDsymUpload).toHaveBeenCalledWith("upload", metadata);
    await tool(group, "retry_dsym_upload").invoke({ id: "upload" });
    expect(service.retryDsymUpload).toHaveBeenCalledWith("upload");
    await tool(group, "delete_dsym_upload").invoke({ id: "upload" });
    expect(service.deleteDsymUpload).toHaveBeenCalledWith("upload");
    expect(
      await tool(group, "delete_crash_reports").invoke({ ids: ["crash"] }),
    ).toEqual({ count: 1 });
    expect(await tool(group, "delete_dsyms").invoke({ ids: ["dsym"] })).toEqual(
      { count: 2 },
    );
    expect(await tool(group, "get_crash_settings").invoke({})).toEqual({
      settings,
    });
    await tool(group, "update_crash_settings").invoke({
      dsymRetentionDays: null,
    });
    expect(service.updateSettings).toHaveBeenCalledWith({
      dsymRetentionDays: null,
    });
    expect(
      JSON.stringify(
        await tool(group, "get_crash_symbolication_agents").invoke({}),
      ),
    ).not.toContain("secret");
    expect(await tool(group, "get_crash_facets").invoke({})).toEqual({
      facets: { apps: [], appVersions: [] },
    });
    expect(await tool(group, "get_dsym_projects").invoke({})).toEqual({
      projects: ["App"],
    });
    expect(
      await tool(group, "symbolicate_crash_report").invoke({ id: "crash" }),
    ).toEqual({ crash: null });
    expect(service.symbolicate).toHaveBeenCalledWith("crash");
    await expect(
      tool(group, "update_crash_settings").invoke({ retentionDays: 0 }),
    ).rejects.toThrow();
    await expect(
      tool(group, "update_dsym_upload").invoke({
        id: "upload",
        input: { url: "file:///etc/passwd" },
      }),
    ).rejects.toThrow();
    expect(service.updateDsymUpload).toHaveBeenCalledTimes(1);
    expect(tool(group, "delete_dsyms").annotations.destructiveHint).toBe(true);
  });

  test("manages drafts with explicit projections and keeps imports agent-only", async () => {
    const status = {
      id: "sync",
      agentId: "agent",
      provider: "CODEX",
      status: "IDLE",
      lastStartedAt: now,
      lastCompletedAt: now,
      lastError: null,
      importedCount: 2,
      unmatchedCount: 0,
      updatedAt: now,
      catalogJson: '{"secret":"value"}',
      cursor: "secret",
    };
    const service = {
      drafts: vi
        .fn()
        .mockResolvedValue({ items: [draft], totalCount: 1, nextCursor: null }),
      draft: vi.fn().mockResolvedValue(draft),
      saveDraft: vi.fn().mockResolvedValue(draft),
      archiveDrafts: vi.fn().mockResolvedValue(1),
      deleteDrafts: vi.fn().mockResolvedValue(1),
      providerImportStatus: vi.fn().mockResolvedValue([status]),
      cancelQuestion: vi.fn().mockResolvedValue({
        id: "run",
        status: "IN_PROGRESS",
        phase: "RUNNING",
        nativeSessionFile: "secret",
      }),
    };
    const group = createRunToolGroup(service as never);
    const page = await tool(group, "get_run_drafts").invoke({ search: "work" });
    expect(service.drafts).toHaveBeenCalledWith({
      search: "work",
      first: 100,
      archive: "ACTIVE",
    });
    expect(page).toMatchObject({
      page: {
        items: [
          { mcpPresetIds: ["preset"], attachments: [{ id: "attachment" }] },
        ],
      },
    });
    expect(JSON.stringify(page)).not.toContain("secret");
    await tool(group, "get_run_draft").invoke({ id: "draft" });
    expect(service.draft).toHaveBeenCalledWith("draft");
    await tool(group, "save_run_draft").invoke({ input: runInput });
    expect(service.saveDraft).toHaveBeenCalledWith({
      ...runInput,
      webSearchEnabled: true,
      attachmentIds: [],
      mcpPresetIds: [],
    });
    await tool(group, "archive_run_drafts").invoke({
      ids: ["draft"],
      archived: false,
    });
    expect(service.archiveDrafts).toHaveBeenCalledWith(["draft"], false);
    await tool(group, "delete_run_drafts").invoke({ ids: ["draft"] });
    expect(service.deleteDrafts).toHaveBeenCalledWith(["draft"]);
    expect(
      JSON.stringify(
        await tool(group, "get_run_provider_import_status").invoke({}),
      ),
    ).not.toContain("secret");
    expect(
      group.tools.some(({ name }) => name === "import_provider_runs"),
    ).toBe(false);
    expect(
      await tool(group, "cancel_run_question").invoke({ batchId: "batch" }),
    ).toEqual({ run: { id: "run", status: "IN_PROGRESS", phase: "RUNNING" } });
    expect(service.cancelQuestion).toHaveBeenCalledWith("batch");
    await expect(
      tool(group, "save_run_draft").invoke({
        input: { ...runInput, prompt: "" },
      }),
    ).rejects.toThrow();
    expect(service.saveDraft).toHaveBeenCalledTimes(1);
  });

  test("exports/imports portable commands and marks permanent deletion", async () => {
    const command = {
      name: "Check",
      script: "npm test",
      targetKind: "ANY_WORKTREE",
    };
    const payload = {
      format: "aide.command.export",
      schemaVersion: 2,
      exportedAt: now.toISOString(),
      command,
    };
    const saved = {
      ...command,
      id: "command",
      description: "",
      targetAgentId: null,
      targetRepositoryIds: [],
      restartPolicy: "NEVER",
      restartLimit: 3,
      concurrency: "NON_EXCLUSIVE",
      blocksGitOperations: false,
      quickActionEnabled: false,
      quickActionIconKey: "terminal",
      quickActionButtonVariant: "default",
      notificationsEnabled: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      targetAgent: { token: "secret" },
    };
    const service = {
      exportDefinition: vi.fn().mockResolvedValue(payload),
      importDefinition: vi.fn().mockResolvedValue(saved),
      deleteDefinition: vi.fn().mockResolvedValue(true),
    };
    const group = createCommandToolGroup(service as never);
    expect(
      await tool(group, "export_command").invoke({ id: "command" }),
    ).toEqual({ payload });
    const imported = await tool(group, "import_command").invoke({
      payload,
      name: "Check copy",
    });
    expect(service.importDefinition).toHaveBeenCalledWith({
      payload,
      name: "Check copy",
    });
    expect(JSON.stringify(imported)).not.toContain("secret");
    await tool(group, "delete_command").invoke({ id: "command" });
    expect(service.deleteDefinition).toHaveBeenCalledWith("command");
    expect(tool(group, "delete_command").annotations.destructiveHint).toBe(
      true,
    );
    expect(tool(group, "import_command").annotations.idempotentHint).toBe(
      false,
    );
    await expect(
      tool(group, "import_command").invoke({
        payload: { name: "Empty script", script: "" },
      }),
    ).rejects.toThrow();
    expect(service.importDefinition).toHaveBeenCalledTimes(1);
  });

  test("exports the full command script size supported by the service", async () => {
    const script = "x".repeat(1_000_000);
    const exportDefinition = vi.fn().mockResolvedValue({
      format: "aide.command.export",
      schemaVersion: 2,
      exportedAt: now.toISOString(),
      command: { name: "Large command", script, targetKind: "ANY_WORKTREE" },
    });
    const group = createCommandToolGroup({ exportDefinition } as never);
    const result = await tool(group, "export_command").invoke({ id: "large" });
    expect(result).toMatchObject({ payload: { command: { script } } });
  });

  test("inspects signing/deployment safely and forwards build configuration operations", async () => {
    const observation = {
      id: "obs",
      scopeKey: "worktree:wt",
      status: "VALID",
      schemesJson: '["App"]',
      configurationsJson: '["Debug"]',
      testPlansJson: "[]",
      error: null,
      stale: false,
      headSha: "sha",
      xcodeVersion: "27",
      lastParseAttemptAt: now,
      lastParsedAt: now,
      internal: "secret",
    };
    const service = {
      reparse: vi.fn().mockResolvedValue(observation),
      deleteProject: vi.fn().mockResolvedValue(true),
      setAllowedScripts: vi.fn().mockResolvedValue({
        id: "project",
        repositoryId: "repo",
        type: "IOS_APP",
        allowedScripts: [
          {
            position: 0,
            script: { id: "script", name: "Check", internal: "secret" },
          },
        ],
      }),
      signingOptionsForBuild: vi.fn().mockResolvedValue({
        teams: [],
        identities: [],
        profiles: [],
        bundles: [],
        privateKey: "secret",
      }),
      runAgentsForBuild: vi.fn().mockResolvedValue([
        {
          agent: {
            id: "agent",
            name: "Mac",
            hostname: "host",
            architecture: "arm64",
            osVersion: "macOS 27",
            token: "secret",
          },
          available: true,
          isBuildAgent: false,
          unavailableReason: null,
        },
      ]),
      destinationsForBuild: vi.fn().mockResolvedValue([]),
    };
    const group = createBuildToolGroup(service as never);
    const result = await tool(group, "reparse_build_configuration").invoke({
      configurationId: "config",
      worktreeId: "wt",
      requestId: "req",
    });
    expect(service.reparse).toHaveBeenCalledWith("config", "wt", "req");
    expect(result).toMatchObject({
      observation: {
        schemes: ["App"],
        configurations: ["Debug"],
        lastParsedAt: now.toISOString(),
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    await tool(group, "delete_build_project").invoke({ id: "project" });
    expect(service.deleteProject).toHaveBeenCalledWith("project");
    const project = await tool(group, "set_codebase_build_scripts").invoke({
      codebaseId: "codebase",
      scriptIds: ["script"],
    });
    expect(service.setAllowedScripts).toHaveBeenCalledWith("codebase", [
      "script",
    ]);
    expect(JSON.stringify(project)).not.toContain("secret");
    expect(
      await tool(group, "get_build_signing_options").invoke({
        buildId: "build",
      }),
    ).toEqual({
      options: { teams: [], identities: [], profiles: [], bundles: [] },
    });
    expect(service.signingOptionsForBuild).toHaveBeenCalledWith("build");
    expect(
      JSON.stringify(
        await tool(group, "get_build_run_agents").invoke({ buildId: "build" }),
      ),
    ).not.toContain("secret");
    await tool(group, "get_build_destinations").invoke({
      buildId: "build",
      requestId: "req",
      targetAgentId: "agent",
    });
    expect(service.destinationsForBuild).toHaveBeenCalledWith(
      "build",
      "req",
      "agent",
    );
    expect(
      tool(group, "get_build_signing_options").annotations.readOnlyHint,
    ).toBe(false);
    expect(
      tool(group, "delete_build_project").annotations.destructiveHint,
    ).toBe(true);
  });
});

describe("repository transfer MCP contract", () => {
  const payload = {
    format: "aide.repository-transfer",
    version: 1,
    scope: "REPOSITORY",
    rootKey: "repository:repo",
    entities: [
      {
        key: "repository:repo",
        kind: "REPOSITORY",
        name: "Repo",
        dependency: false,
        fields: { name: "Repo" },
        references: [],
      },
    ],
  };
  const operation = {
    id: "operation",
    requestId: "request",
    kind: "IMPORT",
    status: "SUCCEEDED",
    appId: null,
    resultJson: '{"imported":1}',
    requestHash: "secret",
    createdAt: now,
    updatedAt: now,
    items: [
      {
        id: "item",
        repositoryId: "repo",
        agentId: "agent",
        codebaseId: "codebase",
        destinationPath: "/repos/Repo",
        status: "SUCCEEDED",
        jobId: null,
        error: null,
        remoteUrl: "https://secret@example.com/repo",
        baseDirectory: "/private/secret",
      },
    ],
  };
  const preview = {
    fingerprint: "fingerprint",
    items: [],
    dependencies: [],
    agents: [],
    destinations: [],
    warnings: [],
    blockers: [],
  };

  test("requires reviewed fingerprints, forwards selections and strips persisted internals", async () => {
    const clones = {
      read: vi.fn().mockResolvedValue(operation),
      get: vi.fn(),
      retry: vi.fn().mockResolvedValue(operation),
    };
    const overview = {
      appId: "app",
      fingerprint: "coverage",
      selectedAgentIds: [],
      agents: [],
      repositories: [],
      destinations: [],
    };
    const service = {
      clones,
      exportPreview: vi
        .fn()
        .mockResolvedValue({ payload, items: [], warnings: [] }),
      export: vi.fn().mockResolvedValue(payload),
      preview: vi.fn().mockResolvedValue(preview),
      apply: vi.fn().mockResolvedValue(operation),
      syncOverview: vi.fn().mockResolvedValue(overview),
      sync: vi.fn().mockResolvedValue(operation),
    };
    const group = createRepositoryTransferToolGroup(service as never);
    const exportInput = {
      scope: "REPOSITORY",
      id: "repo",
      excludedKeys: ["command:cmd"],
    };
    await tool(group, "get_repository_transfer_export_preview").invoke({
      input: exportInput,
    });
    expect(service.exportPreview).toHaveBeenCalledWith(exportInput);
    expect(
      await tool(group, "export_repository_transfer").invoke({
        input: exportInput,
      }),
    ).toEqual({ payload });
    expect(service.export).toHaveBeenCalledWith(exportInput);
    const input = {
      payload,
      includedKeys: ["workflow:workflow"],
      enableWorkflowKeys: ["workflow:workflow"],
    };
    expect(
      await tool(group, "preview_repository_transfer").invoke({ input }),
    ).toEqual({ preview });
    expect(service.preview).toHaveBeenCalledWith(input);
    const applied = await tool(group, "apply_repository_transfer").invoke({
      input,
      fingerprint: "fingerprint",
      requestId: "request",
    });
    expect(service.apply).toHaveBeenCalledWith(input, "fingerprint", "request");
    expect(applied).toMatchObject({
      operation: {
        result: { imported: 1 },
        items: [{ codebaseId: "codebase" }],
      },
    });
    expect(JSON.stringify(applied)).not.toContain("secret");
    await tool(group, "get_repository_transfer_operation").invoke({
      id: "operation",
    });
    expect(clones.read).toHaveBeenCalledWith("operation");
    expect(clones.get).not.toHaveBeenCalled();
    await tool(group, "retry_repository_transfer").invoke({
      id: "operation",
      requestId: "retry",
    });
    expect(clones.retry).toHaveBeenCalledWith("operation", "retry");
    expect(
      await tool(group, "get_app_repository_sync").invoke({ appId: "app" }),
    ).toEqual({ overview });
    expect(service.syncOverview).toHaveBeenCalledWith("app");
    const destinations = [
      { repositoryKey: "repo", agentId: "agent", relativePath: "Repo" },
    ];
    await tool(group, "sync_app_repositories").invoke({
      appId: "app",
      destinations,
      fingerprint: "coverage",
      requestId: "sync",
    });
    expect(service.sync).toHaveBeenCalledWith(
      "app",
      destinations,
      "coverage",
      "sync",
    );
    await expect(
      tool(group, "apply_repository_transfer").invoke({
        input,
        requestId: "request",
      }),
    ).rejects.toThrow();
    expect(service.apply).toHaveBeenCalledTimes(1);
    service.apply.mockRejectedValueOnce(
      new Error("The import preview has changed"),
    );
    await expect(
      tool(group, "apply_repository_transfer").invoke({
        input,
        fingerprint: "stale",
        requestId: "other",
      }),
    ).rejects.toThrow("preview has changed");
    expect(tool(group, "apply_repository_transfer").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(
      tool(group, "get_repository_transfer_operation").annotations.readOnlyHint,
    ).toBe(true);
    expect(
      tool(group, "preview_repository_transfer").annotations.readOnlyHint,
    ).toBe(false);
  });

  test("publishes JSON schemas for recursive portable configuration and strips unknown envelope fields", () => {
    const group = createRepositoryTransferToolGroup({} as never);
    for (const definition of group.tools) {
      expect(z.toJSONSchema(definition.inputSchema).type).toBe("object");
      expect(z.toJSONSchema(definition.outputSchema).type).toBe("object");
    }
  });
});
