import { describe, expect, test, vi } from "vitest";

import type { BuiltInToolDefinition } from "../builtin-tools";
import {
  createCacheServerAdministrationTools,
  createExternalPipelineAdministrationTools,
  createGitHubAdministrationTools,
  createGitLabAdministrationTools,
  createIntegrationCacheAdministrationTools,
  createJiraCacheAdministrationTools,
  createNotificationAdministrationTools,
  createSseViewAdministrationTools,
  createTelemetryAdministrationTools,
  createUsageAdministrationTools,
  createWorkflowQuickActionTools,
  createWorktreeAdministrationTools,
} from "./administration-tools";
import { createToolAdministrationGroup } from "./tool-administration";
import { createWorktreeToolGroup } from "./worktrees";

const find = (tools: BuiltInToolDefinition[], name: string) => {
  const result = tools.find((tool) => tool.name === name);
  if (!result) throw new Error(`Tool ${name} is missing`);
  return result;
};

describe("administration capability contracts", () => {
  test("manages GitHub repository metadata and retry rules through existing guards", async () => {
    const availableRepositories = vi.fn().mockResolvedValue({ items: [] });
    const addRepository = vi.fn().mockResolvedValue([]);
    const setAutoRetryRuleEnabled = vi.fn().mockResolvedValue({ id: "rule" });
    const deleteAutoRetryRule = vi.fn().mockResolvedValue(true);
    const tools = createGitHubAdministrationTools({
      availableRepositories,
      addRepository,
      setAutoRetryRuleEnabled,
      deleteAutoRetryRule,
    });
    await find(tools, "get_github_available_repositories").invoke({
      after: "cursor",
    });
    await find(tools, "add_github_repository").invoke({
      nameWithOwner: "acme/app",
      jiraKeyRegex: "AIDE-[0-9]+",
    });
    await find(tools, "set_auto_retry_rule_enabled").invoke({
      id: "rule",
      enabled: false,
    });
    await find(tools, "delete_auto_retry_rule").invoke({ id: "rule" });
    expect(availableRepositories).toHaveBeenCalledWith("cursor");
    expect(addRepository).toHaveBeenCalledWith({
      nameWithOwner: "acme/app",
      jiraKeyRegex: "AIDE-[0-9]+",
    });
    expect(setAutoRetryRuleEnabled).toHaveBeenCalledWith("rule", false);
    expect(deleteAutoRetryRule).toHaveBeenCalledWith("rule");
    expect(
      find(tools, "delete_auto_retry_rule").annotations.destructiveHint,
    ).toBe(true);
  });

  test("preserves GitLab reviewed SHA and post-merge choices, excluding webhook secrets", async () => {
    const submitMerge = vi.fn().mockResolvedValue({ postMergeError: null });
    const retryMergeFollowUps = vi
      .fn()
      .mockResolvedValue({ postMergeError: null });
    const configureProjectWebhook = vi.fn().mockResolvedValue({
      project: { id: "42" },
      callbackUrl: "https://aide.test/webhook",
      signingToken: "private",
      manualConfigurationRequired: true,
    });
    const tools = createGitLabAdministrationTools({
      submitMerge,
      retryMergeFollowUps,
      configureProjectWebhook,
    });
    await expect(
      find(tools, "gitlab_submit_merge").invoke({ projectId: "42", iid: 7 }),
    ).rejects.toThrow();
    expect(submitMerge).not.toHaveBeenCalled();
    const input = {
      projectId: "42",
      iid: 7,
      sha: "reviewed-sha",
      autoMerge: true,
      squash: true,
      worktreeId: "wt",
      deleteWorktree: true,
      moveTicketToDone: true,
    };
    await find(tools, "gitlab_submit_merge").invoke(input);
    expect(submitMerge).toHaveBeenCalledWith(input);
    await find(tools, "gitlab_retry_merge_follow_ups").invoke({
      projectId: "42",
      iid: 7,
    });
    expect(retryMergeFollowUps).toHaveBeenCalledWith("42", 7);
    await expect(
      find(tools, "gitlab_configure_project_webhook").invoke({
        projectId: "42",
        callbackUrl: "https://aide.test/webhook",
      }),
    ).resolves.toEqual({
      setup: {
        project: { id: "42" },
        callbackUrl: "https://aide.test/webhook",
        manualConfigurationRequired: true,
      },
    });
  });

  test("routes external pipeline actions through native/external eligibility checks", async () => {
    const dispatchPipelineAction = vi
      .fn()
      .mockResolvedValue({ pipeline: { id: "pipe" } });
    const tools = createGitLabAdministrationTools({ dispatchPipelineAction });
    await find(tools, "gitlab_run_pipeline_action").invoke({
      projectId: "42",
      pipelineId: "pipe",
      action: "RETRY",
      jobId: "external",
    });
    expect(dispatchPipelineAction).toHaveBeenCalledWith(
      "42",
      "pipe",
      "RETRY",
      "MCP",
      "external",
    );
    expect(
      find(tools, "gitlab_run_pipeline_action").annotations.idempotentHint,
    ).toBe(false);
    const saveConfiguration = vi
      .fn()
      .mockResolvedValue({ repositoryId: "repo" });
    const executions = vi.fn().mockResolvedValue([
      {
        id: "exec",
        output: "redacted",
        outputJson: "internal",
        targetedStatusIdsJson: "internal",
        targetedStatusIds: ["job"],
      },
    ]);
    const administration = createExternalPipelineAdministrationTools({
      saveConfiguration,
      executions,
    });
    await find(administration, "save_external_pipeline_actions").invoke({
      repositoryId: "repo",
      enabled: true,
      retryScript: "return 1",
      cancelScript: "return 0",
    });
    expect(saveConfiguration).toHaveBeenCalledWith("repo", {
      enabled: true,
      retryScript: "return 1",
      cancelScript: "return 0",
    });
    await expect(
      find(administration, "save_external_pipeline_actions").invoke({
        repositoryId: "repo",
        enabled: true,
        retryScript: "x".repeat(100_001),
        cancelScript: "",
      }),
    ).rejects.toThrow();
    await expect(
      find(administration, "get_external_pipeline_executions").invoke({
        projectId: "42",
        pipelineId: "pipe",
      }),
    ).resolves.toEqual({
      executions: [
        { id: "exec", output: "redacted", targetedStatusIds: ["job"] },
      ],
    });
  });

  test("retains cache credentials and stored headers while editing connection metadata", async () => {
    const getSettings = vi.fn().mockResolvedValue({
      headers: [{ name: "X-Auth", valueConfigured: true }],
    });
    const saveSettings = vi.fn().mockResolvedValue({ configured: true });
    const tools = createCacheServerAdministrationTools({
      getSettings,
      saveSettings,
    });
    await find(tools, "save_cache_server_settings").invoke({
      baseUrl: "https://cache.test",
    });
    expect(saveSettings).toHaveBeenCalledWith({
      baseUrl: "https://cache.test",
      headers: [{ name: "X-Auth" }],
    });
    await find(tools, "save_cache_server_settings").invoke({
      baseUrl: "https://cache.test",
      headers: [],
    });
    expect(saveSettings).toHaveBeenLastCalledWith({
      baseUrl: "https://cache.test",
      headers: [],
    });
    await expect(
      find(tools, "save_cache_server_settings").invoke({ baseUrl: "invalid" }),
    ).rejects.toThrow();
    expect(
      find(tools, "delete_cache_server_entries_by_filter").annotations
        .destructiveHint,
    ).toBe(true);
  });

  test("forwards selective cache, TTL, and API-history operations", async () => {
    const cachedEntry = vi.fn().mockResolvedValue({ id: "entry" });
    const saveCacheTtlOverride = vi
      .fn()
      .mockResolvedValue({ operation: "Query" });
    const clearApiCalls = vi.fn().mockResolvedValue(true);
    const tools = createIntegrationCacheAdministrationTools(
      { cachedEntry, saveCacheTtlOverride, clearApiCalls },
      "github",
    );
    await find(tools, "get_github_cached_entry").invoke({ id: "entry" });
    await find(tools, "save_github_cache_ttl_override").invoke({
      operation: "Query",
      ttlSeconds: 0,
    });
    await find(tools, "clear_github_api_calls").invoke({});
    expect(cachedEntry).toHaveBeenCalledWith("entry");
    expect(saveCacheTtlOverride).toHaveBeenCalledWith("Query", 0);
    expect(clearApiCalls).toHaveBeenCalledWith();
    const jira = createJiraCacheAdministrationTools({ clearApiCalls });
    await find(jira, "clear_jira_api_calls").invoke({});
    expect(clearApiCalls).toHaveBeenCalledTimes(2);
  });

  test("uses supported editor settings and existing worktree deletion boundaries", async () => {
    const saveSettings = vi
      .fn()
      .mockResolvedValue({ editorVariant: "CODE_INSIDERS" });
    const purge = vi.fn().mockResolvedValue(true);
    const tools = createWorktreeAdministrationTools({ saveSettings, purge });
    await find(tools, "save_worktree_settings").invoke({
      editorVariant: "CODE_INSIDERS",
    });
    expect(saveSettings).toHaveBeenCalledWith("CODE_INSIDERS");
    await expect(
      find(tools, "save_worktree_settings").invoke({
        editorVariant: "unsupported",
      }),
    ).rejects.toThrow();
    await find(tools, "purge_hidden_worktree").invoke({ id: "hidden" });
    expect(purge).toHaveBeenCalledWith("hidden");
    expect(
      find(tools, "purge_hidden_worktree").annotations.destructiveHint,
    ).toBe(true);
    expect(
      find(tools, "preview_worktree_ticket_branch").annotations,
    ).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    const overview = {
      agents: [],
      tags: [{ id: "unassigned-tag", name: "Unused", color: "red" }],
    };
    const existingTools = createWorktreeToolGroup({
      overview: vi.fn().mockResolvedValue(overview),
    } as never).tools;
    await expect(
      find(existingTools, "get_worktrees").invoke({}),
    ).resolves.toEqual({ overview });
  });

  test("projects native device and subscription metadata without push credentials", async () => {
    const notificationDevices = vi.fn().mockResolvedValue([
      {
        id: "device",
        topic: "app",
        status: "ACTIVE",
        token: "raw-token",
        tokenHash: "hash",
        tokenMasked: "abcd…efgh",
        lastRegisteredAt: new Date("2026-10-28T00:00:00Z"),
      },
    ]);
    const webPushSubscriptions = vi.fn().mockResolvedValue([
      {
        id: "subscription",
        endpoint: "private-endpoint",
        p256dh: "key",
        auth: "secret",
        userAgent: "Browser",
      },
    ]);
    const testNotificationDevice = vi.fn().mockResolvedValue(true);
    const tools = createNotificationAdministrationTools({
      notificationDevices,
      webPushSubscriptions,
      testNotificationDevice,
    });
    await expect(
      find(tools, "get_notification_devices").invoke({}),
    ).resolves.toEqual({
      devices: [
        {
          id: "device",
          topic: "app",
          status: "ACTIVE",
          tokenMasked: "abcd…efgh",
          lastRegisteredAt: "2026-10-28T00:00:00.000Z",
        },
      ],
    });
    await expect(
      find(tools, "get_web_push_subscriptions").invoke({}),
    ).resolves.toEqual({
      subscriptions: [{ id: "subscription", userAgent: "Browser" }],
    });
    await find(tools, "test_notification_device").invoke({ id: "device" });
    expect(testNotificationDevice).toHaveBeenCalledWith("device");
    expect(
      find(tools, "test_notification_device").annotations.idempotentHint,
    ).toBe(false);
  });

  test("supports unified telemetry and SSE saved views using service-owned validation", async () => {
    const saveViewSettings = vi.fn().mockResolvedValue({ view: "UNIFIED" });
    const deleteFilter = vi.fn().mockResolvedValue(true);
    const telemetry = createTelemetryAdministrationTools({
      saveViewSettings,
      deleteFilter,
    });
    await find(telemetry, "save_telemetry_view_settings").invoke({
      view: "UNIFIED",
      timeFormat: "24",
      activeSavedFilterId: null,
    });
    expect(saveViewSettings).toHaveBeenCalledWith({
      view: "UNIFIED",
      timeFormat: "24",
      activeSavedFilterId: null,
    });
    await find(telemetry, "delete_telemetry_filter").invoke({ id: "filter" });
    expect(deleteFilter).toHaveBeenCalledWith("filter");
    const saveHistorySavedFilter = vi.fn().mockResolvedValue({ id: "filter" });
    const sse = createSseViewAdministrationTools({ saveHistorySavedFilter });
    const input = {
      view: "EVENTS",
      name: "Errors",
      definition: { search: "error" },
    };
    await find(sse, "sse_history_save_filter").invoke(input);
    expect(saveHistorySavedFilter).toHaveBeenCalledWith(input);
    await expect(
      find(sse, "sse_history_save_filter").invoke({
        ...input,
        view: "INVALID",
      }),
    ).rejects.toThrow();
  });

  test("forwards usage settings and workflow quick action types", async () => {
    const clearHistory = vi.fn().mockResolvedValue(3);
    const saveSettings = vi.fn().mockResolvedValue({ catalogUrl: null });
    const tools = createUsageAdministrationTools(
      { clearHistory },
      { saveSettings },
    );
    await find(tools, "clear_ccusage_history").invoke({});
    await find(tools, "save_model_cost_settings").invoke({ catalogUrl: null });
    expect(clearHistory).toHaveBeenCalledWith();
    expect(saveSettings).toHaveBeenCalledWith(null);
    const setQuickAction = vi
      .fn()
      .mockResolvedValue({ id: "workflow", name: "Checks" });
    const workflows = createWorkflowQuickActionTools({ setQuickAction });
    const input = {
      id: "workflow",
      kind: "GITLAB_PIPELINES",
      quickActionIconKey: "wrench",
      quickActionButtonVariant: "default",
      repositoryIds: ["repo"],
    };
    await find(workflows, "set_workflow_quick_action").invoke(input);
    expect(setQuickAction).toHaveBeenCalledWith(input);
  });

  test("requires and forwards reviewed preset import tokens", async () => {
    const previewPresetImport = vi.fn().mockResolvedValue({
      token: "review-token",
      canImport: true,
      errors: [],
      entries: [],
      externalServers: [],
    });
    const importPresets = vi.fn().mockResolvedValue({ imported: 1 });
    const tools = createToolAdministrationGroup(
      {} as never,
      vi.fn(),
      undefined,
      { previewPresetImport, importPresets } as never,
    ).tools;
    const input = {
      document: '{"presets":[]}',
      serverMappings: [{ serverKey: "source", serverId: "local" }],
    };
    await expect(
      find(tools, "preview_mcp_tool_preset_import").invoke({ input }),
    ).resolves.toEqual({
      preview: {
        token: "review-token",
        canImport: true,
        errors: [],
        entries: [],
        externalServers: [],
      },
    });
    await expect(
      find(tools, "import_mcp_tool_presets").invoke({ input }),
    ).rejects.toThrow();
    expect(importPresets).not.toHaveBeenCalled();
    await find(tools, "import_mcp_tool_presets").invoke({
      input,
      previewToken: "review-token",
    });
    expect(importPresets).toHaveBeenCalledWith(input, "review-token");
    expect(
      find(tools, "import_mcp_tool_presets").annotations.idempotentHint,
    ).toBe(false);
  });

  test("external connection edits forward metadata and existing header IDs without new credential values", async () => {
    const updateExternalServer = vi.fn().mockResolvedValue({
      id: "server",
      headers: [{ id: "header", name: "Authorization", valueConfigured: true }],
    });
    const externalServers = vi.fn().mockResolvedValue([
      {
        id: "server",
        headers: [
          { id: "header", name: "Authorization", valueConfigured: true },
        ],
      },
    ]);
    const tools = createToolAdministrationGroup(
      {} as never,
      vi.fn(),
      undefined,
      { updateExternalServer, externalServers } as never,
    ).tools;
    await find(tools, "update_external_mcp_server").invoke({
      id: "server",
      input: {
        name: "Docs",
        url: "https://docs.test/mcp",
        transport: "STREAMABLE_HTTP",
        headers: [
          { id: "header", name: "Authorization", value: "must-not-forward" },
        ],
      },
    });
    expect(updateExternalServer).toHaveBeenCalledWith("server", {
      name: "Docs",
      url: "https://docs.test/mcp",
      transport: "STREAMABLE_HTTP",
      headers: [{ id: "header", name: "Authorization" }],
    });
    await find(tools, "update_external_mcp_server").invoke({
      id: "server",
      input: {
        name: "Docs",
        url: "https://docs.test/mcp",
        transport: "STREAMABLE_HTTP",
      },
    });
    expect(updateExternalServer).toHaveBeenLastCalledWith("server", {
      name: "Docs",
      url: "https://docs.test/mcp",
      transport: "STREAMABLE_HTTP",
      headers: [{ id: "header", name: "Authorization" }],
    });
  });
});
