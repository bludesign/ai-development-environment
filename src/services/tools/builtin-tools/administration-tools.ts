import * as z from "zod/v4";
import type { AgentControlService } from "@/services/agent-control";
import type { CacheServerService } from "@/services/cache-server";
import type { CcusageService } from "@/services/ccusage";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { ExternalPipelineActionsService } from "@/services/gitlab/external-pipeline-actions";
import type { JiraService } from "@/services/jira";
import type { ModelCostsService } from "@/services/model-costs";
import type { NotificationsService } from "@/services/notifications";
import type { SseService } from "@/services/sse";
import type { TelemetryService } from "@/services/telemetry";
import type { WorkflowsService } from "@/services/workflows";
import type { WorktreesService } from "@/services/worktrees";

import {
  DESTRUCTIVE_ANNOTATIONS,
  DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  type BuiltInToolDefinition,
  type ToolAnnotations,
} from "../builtin-tools";
import {
  invokeService,
  redactSensitiveToolOutput,
  serviceTool,
} from "./service-tool";
import { agentView, workflowView } from "../builtin-views";

const id = z.string().trim().min(1).max(500);
const ids = z.array(id).max(500);
const empty = z.object({});
const identifier = z.object({ id });
const optionalId = id.nullable().optional();
const text = z.string().max(20_000);
const projectRequest = z.object({
  projectId: id,
  iid: z.number().int().positive(),
});

function operation<S extends object, I extends z.ZodType>(
  service: S,
  name: string,
  description: string,
  inputSchema: I,
  method: Extract<keyof S, string>,
  args: ((value: z.output<I>) => unknown[]) | undefined,
  resultKey: string,
  annotations: ToolAnnotations = READ_ONLY_ANNOTATIONS,
  mapResult?: (value: unknown) => unknown,
): BuiltInToolDefinition {
  return serviceTool({
    service,
    name,
    title: name
      .replaceAll("_", " ")
      .replace(/^./, (value) => value.toUpperCase()),
    description,
    inputSchema,
    method,
    arguments: args,
    resultKey,
    annotations,
    mapResult,
  });
}

/** Explicit projections keep integration secrets out of these control-plane tools. */
function project(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object") return value;
  return redactSensitiveToolOutput(
    Object.fromEntries(
      keys
        .filter((key) => key in value)
        .map((key) => [key, (value as Record<string, unknown>)[key]]),
    ),
  );
}

export function createGitHubAdministrationTools(
  service: Partial<GitHubService>,
) {
  return [
    operation(
      service,
      "get_github_settings",
      "Read GitHub connection status, merge defaults, Jira parsing, and polling settings without credential values.",
      empty,
      "getSettings",
      () => [],
      "settings",
    ),
    operation(
      service,
      "save_github_preferences",
      "Update GitHub merge defaults, Jira parsing, and Actions polling preferences while preserving configured credentials.",
      z.object({
        defaultMergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]).optional(),
        emptyMergeCommitDescription: z.boolean().optional(),
        defaultMoveTicketToDone: z.boolean().optional(),
        defaultDeleteWorktree: z.boolean().optional(),
        defaultJiraKeyRegex: text.optional(),
        actionsNotificationPollIntervalSeconds: z
          .number()
          .int()
          .min(30)
          .max(3600)
          .optional(),
      }),
      "saveSettings",
      undefined,
      "settings",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "get_github_available_repositories",
      "Discover accessible GitHub repositories that can be managed by AIDE.",
      z.object({ after: optionalId }),
      "availableRepositories",
      ({ after }) => [after],
      "page",
      READ_ONLY_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "add_github_repository",
      "Add an accessible GitHub repository to AIDE's managed repositories.",
      z.object({
        nameWithOwner: z.string().min(3).max(500),
        jiraKeyRegex: text.nullable().optional(),
      }),
      "addRepository",
      undefined,
      "repositories",
      { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
    ),
    operation(
      service,
      "update_github_repository",
      "Update the Jira issue-key pattern for a managed GitHub repository.",
      identifier.extend({ jiraKeyRegex: text.nullable().optional() }),
      "updateRepository",
      undefined,
      "repositories",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "remove_github_repository",
      "Remove a managed GitHub repository from AIDE without deleting the repository on GitHub.",
      identifier,
      "removeRepository",
      ({ id }) => [id],
      "repositories",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "set_auto_retry_rule_enabled",
      "Enable or disable a GitHub pipeline auto-retry rule.",
      identifier.extend({ enabled: z.boolean() }),
      "setAutoRetryRuleEnabled",
      ({ id, enabled }) => [id, enabled],
      "rule",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "delete_auto_retry_rule",
      "Delete a GitHub pipeline auto-retry rule.",
      identifier,
      "deleteAutoRetryRule",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "get_github_webhook_deliveries",
      "List GitHub webhook delivery diagnostics without credential values.",
      z.object({
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      }),
      "webhookDeliveries",
      ({ limit, offset }) => [limit, offset],
      "page",
    ),
    operation(
      service,
      "clear_github_webhook_deliveries",
      "Clear GitHub webhook delivery history.",
      empty,
      "clearWebhookDeliveries",
      () => [],
      "cleared",
      DESTRUCTIVE_ANNOTATIONS,
    ),
  ];
}

export function createGitLabAdministrationTools(
  service: Partial<GitLabService>,
) {
  const discovery = z.object({
    search: text.nullable().optional(),
    page: z.number().int().positive().default(1),
    perPage: z.number().int().min(1).max(100).default(50),
  });
  return [
    operation(
      service,
      "gitlab_update_connection_settings",
      "Update GitLab origin and pipeline polling interval using the configured access token; verifies the connection before saving.",
      z.object({
        baseUrl: z.url().max(2000),
        pipelinePollIntervalSeconds: z
          .number()
          .int()
          .min(30)
          .max(3600)
          .optional(),
      }),
      "saveSettings",
      undefined,
      "settings",
      WRITE_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_get_settings",
      "Read GitLab connection status and nonsecret preferences without access-token values.",
      empty,
      "getSettings",
      () => [],
      "settings",
    ),
    operation(
      service,
      "gitlab_save_preferences",
      "Update GitLab project discovery and default merge follow-up preferences.",
      z.object({
        memberProjectsOnly: z.boolean().optional(),
        defaultSquash: z.boolean().optional(),
        defaultMoveTicketToDone: z.boolean().optional(),
        defaultDeleteWorktree: z.boolean().optional(),
      }),
      "savePreferences",
      undefined,
      "settings",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_get_available_projects",
      "Discover GitLab projects available to add to AIDE.",
      discovery,
      "availableProjects",
      ({ search, page, perPage }) => [search, page, perPage],
      "page",
      READ_ONLY_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_get_accessible_projects",
      "Search accessible GitLab projects, including projects not managed by AIDE.",
      discovery,
      "accessibleProjects",
      ({ search, page, perPage }) => [search, page, perPage],
      "page",
      READ_ONLY_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_add_project",
      "Add an accessible GitLab project to AIDE.",
      z.object({ projectId: id }),
      "addProject",
      ({ projectId }) => [projectId],
      "projects",
      { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
    ),
    operation(
      service,
      "gitlab_remove_project",
      "Remove a managed GitLab project and its webhook; force bypasses webhook-removal failure.",
      z.object({ projectId: id, force: z.boolean().default(false) }),
      "removeProject",
      ({ projectId, force }) => [projectId, force],
      "projects",
      DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_configure_project_webhook",
      "Configure a managed project's webhook using AIDE's stored signing secret. Secret values are omitted from the result.",
      z.object({ projectId: id, callbackUrl: z.url().max(2000) }),
      "configureProjectWebhook",
      ({ projectId, callbackUrl }) => [projectId, callbackUrl],
      "setup",
      WRITE_EXTERNAL_ANNOTATIONS,
      (value) =>
        project(value, [
          "project",
          "callbackUrl",
          "manualConfigurationRequired",
        ]),
    ),
    operation(
      service,
      "gitlab_remove_project_webhook",
      "Remove the AIDE webhook from a managed GitLab project.",
      z.object({ projectId: id }),
      "removeProjectWebhook",
      ({ projectId }) => [projectId],
      "project",
      DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_get_merge_options",
      "Refresh merge policy and readiness, reviewed SHA, and available post-merge follow-ups before submitting a merge.",
      projectRequest.extend({ worktreeId: optionalId }),
      "mergeOptions",
      ({ projectId, iid, worktreeId }) => [projectId, iid, worktreeId],
      "options",
      READ_ONLY_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_submit_merge",
      "Merge or enable auto-merge for the reviewed SHA, preserving safe worktree cleanup and Jira follow-ups.",
      projectRequest.extend({
        sha: z.string().min(1).max(128),
        autoMerge: z.boolean().optional(),
        squash: z.boolean().optional(),
        removeSourceBranch: z.boolean().optional(),
        mergeCommitMessage: text.nullable().optional(),
        squashCommitMessage: text.nullable().optional(),
        worktreeId: optionalId,
        deleteWorktree: z.boolean().optional(),
        moveTicketToDone: z.boolean().optional(),
      }),
      "submitMerge",
      undefined,
      "result",
      WRITE_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_cancel_auto_merge",
      "Cancel a GitLab merge request's native auto-merge request.",
      projectRequest,
      "cancelAutoMerge",
      ({ projectId, iid }) => [projectId, iid],
      "result",
      WRITE_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_retry_merge_follow_ups",
      "Retry failed Jira or worktree follow-ups after a confirmed GitLab merge.",
      projectRequest,
      "retryMergeFollowUps",
      ({ projectId, iid }) => [projectId, iid],
      "result",
      WRITE_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "gitlab_get_merge_operation",
      "Read the persisted GitLab merge intent and post-merge follow-up outcomes.",
      projectRequest,
      "mergeOperation",
      ({ projectId, iid }) => [projectId, iid],
      "operation",
    ),
    operation(
      service,
      "gitlab_run_pipeline_action",
      "Retry or cancel eligible native and external pipeline jobs using the configured action scripts.",
      z.object({
        projectId: id,
        pipelineId: id,
        action: z.enum(["RETRY", "CANCEL"]),
        jobId: optionalId,
      }),
      "dispatchPipelineAction",
      ({ projectId, pipelineId, action, jobId }) => [
        projectId,
        pipelineId,
        action,
        "MCP",
        jobId ?? undefined,
      ],
      "result",
      { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
    ),
    operation(
      service,
      "gitlab_get_webhook_deliveries",
      "List GitLab webhook delivery diagnostics.",
      z.object({
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().nonnegative().default(0),
      }),
      "webhookDeliveries",
      ({ limit, offset }) => [limit, offset],
      "page",
    ),
    operation(
      service,
      "gitlab_get_comments",
      "Read and refresh merge-request discussion comments with pagination.",
      z.object({
        projectId: optionalId,
        iid: z.number().int().positive().nullable().optional(),
        discussionId: optionalId,
        after: optionalId,
        first: z.number().int().min(1).max(100).default(50),
        refresh: z.boolean().default(false),
      }),
      "comments",
      undefined,
      "page",
      READ_ONLY_EXTERNAL_ANNOTATIONS,
    ),
  ];
}

export function createExternalPipelineAdministrationTools(
  service: Partial<ExternalPipelineActionsService>,
) {
  return [
    operation(
      service,
      "get_external_pipeline_actions",
      "Get repository external pipeline action scripts and secret names; secret values are excluded.",
      z.object({ repositoryId: id }),
      "configuration",
      ({ repositoryId }) => [repositoryId],
      "configuration",
    ),
    operation(
      service,
      "save_external_pipeline_actions",
      "Save repository retry/cancel scripts for external pipeline statuses. Uses previously configured named secrets.",
      z.object({
        repositoryId: id,
        enabled: z.boolean(),
        retryScript: z.string().max(100_000),
        cancelScript: z.string().max(100_000),
      }),
      "saveConfiguration",
      ({ repositoryId, ...input }) => [repositoryId, input],
      "configuration",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "get_external_pipeline_executions",
      "Read external pipeline action execution outcomes and redacted output.",
      z.object({ projectId: id, pipelineId: id }),
      "executions",
      ({ projectId, pipelineId }) => [projectId, pipelineId],
      "executions",
      READ_ONLY_ANNOTATIONS,
      (value) =>
        Array.isArray(value)
          ? value.map((entry) =>
              project(entry, [
                "id",
                "repositoryId",
                "projectId",
                "pipelineId",
                "action",
                "origin",
                "status",
                "targetedStatusIds",
                "nativeStatus",
                "externalStatus",
                "message",
                "output",
                "startedAt",
                "completedAt",
              ]),
            )
          : [],
    ),
  ];
}

export function createWorktreeAdministrationTools(
  service: Partial<WorktreesService>,
) {
  const branch = z.object({
    codebaseId: id,
    worktreeId: optionalId,
    ticketKey: id,
  });
  return [
    operation(
      service,
      "get_worktree_settings",
      "Read shared worktree editor settings.",
      empty,
      "settings",
      () => [],
      "settings",
    ),
    operation(
      service,
      "save_worktree_settings",
      "Set the shared worktree editor variant.",
      z.object({ editorVariant: z.enum(["CODE", "CODE_INSIDERS", "NONE"]) }),
      "saveSettings",
      ({ editorVariant }) => [editorVariant],
      "settings",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "save_worktree_tag",
      "Create or update a reusable worktree tag definition.",
      z.object({
        id: optionalId,
        name: z.string().trim().min(1).max(200),
        color: z.string().min(1).max(100),
      }),
      "saveTag",
      undefined,
      "tag",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "delete_worktree_tag",
      "Delete a reusable worktree tag and remove its assignments.",
      identifier,
      "deleteTag",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "purge_hidden_worktree",
      "Permanently remove one hidden worktree's stored history. This does not delete files on an agent.",
      identifier,
      "purge",
      ({ id }) => [id],
      "purged",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "purge_all_hidden_worktrees",
      "Permanently remove all hidden worktrees' stored history.",
      empty,
      "purgeAll",
      () => [],
      "count",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "preview_worktree_ticket_branch",
      "Preview the configured ticket branch name. AI naming may queue an agent job and wait for generation; use get_worktree_ticket_branch_context for a read-only preview.",
      branch,
      "previewTicketBranch",
      undefined,
      "preview",
      { ...WRITE_ANNOTATIONS, idempotentHint: false },
    ),
  ];
}

export function createNotificationAdministrationTools(
  service: Partial<NotificationsService>,
) {
  return [
    operation(
      service,
      "get_web_push_subscriptions",
      "List web-push subscription metadata without endpoints or subscription keys.",
      empty,
      "webPushSubscriptions",
      () => [],
      "subscriptions",
      READ_ONLY_ANNOTATIONS,
      (value) =>
        Array.isArray(value)
          ? value.map((entry) =>
              project(entry, [
                "id",
                "label",
                "userAgent",
                "expirationTime",
                "lastSeenAt",
                "createdAt",
                "updatedAt",
              ]),
            )
          : [],
    ),
    operation(
      service,
      "prepare_web_push",
      "Prepare the application's web-push signing identity without exposing its private key.",
      empty,
      "prepareWebPush",
      () => [],
      "prepared",
      WRITE_ANNOTATIONS,
      () => true,
    ),
    operation(
      service,
      "delete_web_push_subscription",
      "Delete a saved web-push subscription by ID.",
      identifier,
      "deleteWebPushSubscription",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "get_notification_apns_status",
      "Read native notification delivery readiness without credential values.",
      empty,
      "apnsState",
      () => [],
      "status",
    ),
    operation(
      service,
      "get_notification_devices",
      "List registered native notification devices with masked tokens.",
      empty,
      "notificationDevices",
      () => [],
      "devices",
      READ_ONLY_ANNOTATIONS,
      (value) =>
        Array.isArray(value)
          ? value.map((entry) =>
              project(entry, [
                "id",
                "displayName",
                "deviceName",
                "deviceModel",
                "platform",
                "topic",
                "environment",
                "tokenMasked",
                "appVersion",
                "appBuild",
                "osVersion",
                "locale",
                "status",
                "lastFailureAt",
                "lastFailureReason",
                "lastDeliveredAt",
                "lastRegisteredAt",
                "createdAt",
                "updatedAt",
              ]),
            )
          : [],
    ),
    operation(
      service,
      "rename_notification_device",
      "Rename a registered native notification device.",
      identifier.extend({ displayName: z.string().trim().min(1).max(200) }),
      "renameNotificationDevice",
      ({ id, displayName }) => [id, displayName],
      "device",
      WRITE_ANNOTATIONS,
      (value) =>
        project(value, [
          "id",
          "displayName",
          "deviceName",
          "deviceModel",
          "topic",
          "environment",
          "status",
          "updatedAt",
        ]),
    ),
    operation(
      service,
      "delete_notification_device",
      "Delete a registered native notification device.",
      identifier,
      "deleteNotificationDevice",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "test_notification_device",
      "Send a test native notification to a registered device.",
      identifier,
      "testNotificationDevice",
      ({ id }) => [id],
      "sent",
      { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
    ),
  ];
}

export function createCacheServerAdministrationTools(
  service: Partial<CacheServerService>,
) {
  const filters = z.object({
    key: text.nullable().optional(),
    version: text.nullable().optional(),
    scope: text.nullable().optional(),
    repoId: optionalId,
  });
  const settings = {
    saveSettings: async (input: {
      baseUrl: string;
      headers?: Array<{ name: string }>;
    }) => {
      const current = (await invokeService(service, "getSettings")) as {
        headers?: Array<{ name: string }>;
      };
      return invokeService(service, "saveSettings", [
        {
          ...input,
          headers:
            input.headers ??
            current.headers?.map(({ name }) => ({ name })) ??
            [],
        },
      ]);
    },
  };
  return [
    operation(
      service,
      "get_cache_server_settings",
      "Read cache server connection metadata without API keys or header values.",
      empty,
      "getSettings",
      () => [],
      "settings",
      READ_ONLY_ANNOTATIONS,
    ),
    operation(
      settings,
      "save_cache_server_settings",
      "Update the cache server base URL while retaining its configured API key and headers. Optional header names select existing stored headers; credentials must already be configured.",
      z.object({
        baseUrl: z.url().max(2000),
        headers: z
          .array(z.object({ name: id }))
          .max(100)
          .optional(),
      }),
      "saveSettings",
      undefined,
      "settings",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "test_cache_server_connection",
      "Test the configured cache server connection without exposing credentials.",
      empty,
      "testConnection",
      () => [],
      "status",
      READ_ONLY_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "delete_cache_server_entries_by_filter",
      "Permanently delete cache server entries matching the supplied filters. Empty filters select all entries.",
      filters,
      "deleteCacheEntries",
      undefined,
      "count",
      DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
    ),
    operation(
      service,
      "delete_cache_storage_location",
      "Delete a cache storage location and associated stored data.",
      identifier,
      "deleteStorageLocation",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
    ),
  ];
}

export function createIntegrationCacheAdministrationTools(
  service: Partial<GitHubService> | Partial<GitLabService>,
  provider: "github" | "gitlab",
) {
  const prefix = provider;
  return [
    operation(
      service,
      `get_${prefix}_cached_entry`,
      `Read one cached ${provider} API response.`,
      identifier,
      "cachedEntry",
      ({ id }) => [id],
      "entry",
    ),
    operation(
      service,
      `delete_${prefix}_cached_entry`,
      `Delete one cached ${provider} API response.`,
      identifier,
      "deleteCachedEntry",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    ...(provider === "github"
      ? [
          operation(
            service as Partial<GitHubService>,
            "get_github_cacheable_operations",
            "List GitHub GraphQL operation names that support per-operation cache TTL overrides.",
            empty,
            "cacheableGraphqlOperations",
            () => [],
            "operations",
          ),
          operation(
            service as Partial<GitHubService>,
            "refresh_github_cached_entry",
            "Refresh a cached GitHub API response from GitHub.",
            identifier,
            "refreshCachedEntry",
            ({ id }) => [id],
            "entry",
            WRITE_EXTERNAL_ANNOTATIONS,
          ),
          operation(
            service as Partial<GitHubService>,
            "clear_github_api_calls",
            "Clear GitHub API-call history.",
            empty,
            "clearApiCalls",
            () => [],
            "cleared",
            DESTRUCTIVE_ANNOTATIONS,
          ),
        ]
      : []),
    operation(
      service,
      `get_${prefix}_cache_ttl_overrides`,
      `List per-operation ${provider} cache TTL overrides.`,
      empty,
      "cacheTtlOverrides",
      () => [],
      "overrides",
    ),
    operation(
      service,
      `update_${prefix}_cache_ttl`,
      `Set the default ${provider} cache TTL in minutes.`,
      z.object({ ttlMinutes: z.number().int().min(1).max(1440) }),
      "updateCacheTtl",
      ({ ttlMinutes }) => [ttlMinutes],
      "settings",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      `save_${prefix}_cache_ttl_override`,
      `Set one ${provider} operation's cache TTL in seconds.`,
      z.object({
        operation: id,
        ttlSeconds: z.number().int().min(0).max(86_400),
      }),
      "saveCacheTtlOverride",
      ({ operation, ttlSeconds }) => [operation, ttlSeconds],
      "override",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      `delete_${prefix}_cache_ttl_override`,
      `Remove one ${provider} operation's cache TTL override.`,
      z.object({ operation: id }),
      "deleteCacheTtlOverride",
      ({ operation }) => [operation],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
  ];
}

export function createJiraCacheAdministrationTools(
  service: Partial<JiraService>,
) {
  return [
    operation(
      service,
      "get_jira_cached_ticket",
      "Read one cached Jira issue and its cache metadata.",
      z.object({ issueKey: id }),
      "cachedTicket",
      ({ issueKey }) => [issueKey],
      "ticket",
    ),
    operation(
      service,
      "clear_jira_api_calls",
      "Clear Jira API-call history.",
      empty,
      "clearApiCalls",
      () => [],
      "cleared",
      DESTRUCTIVE_ANNOTATIONS,
    ),
  ];
}

export function createTelemetryAdministrationTools(
  service: Partial<TelemetryService>,
) {
  return [
    operation(
      service,
      "save_telemetry_view_settings",
      "Save telemetry columns, time format, and selected saved views or filters.",
      z.object({
        view: z.enum(["UNIFIED", "CONSOLE", "ANALYTICS"]),
        columns: z.array(id).max(100).nullable().optional(),
        timeFormat: z.enum(["12", "24"]).nullable().optional(),
        activeColumnPresetId: optionalId,
        activeSavedFilterId: optionalId,
      }),
      "saveViewSettings",
      undefined,
      "settings",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "delete_telemetry_preset",
      "Delete a saved telemetry column preset.",
      identifier,
      "deleteColumnPreset",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "delete_telemetry_filter",
      "Delete a saved telemetry filter.",
      identifier,
      "deleteFilter",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
  ];
}

export function createSseViewAdministrationTools(service: Partial<SseService>) {
  const view = z.enum(["STREAMS", "EVENTS"]);
  return [
    operation(
      service,
      "sse_history_get_view_settings",
      "Read saved SSE history columns, time format, and active presets.",
      z.object({ view }),
      "historyViewSettings",
      ({ view }) => [view],
      "settings",
    ),
    operation(
      service,
      "sse_history_save_view_settings",
      "Save SSE history columns, time format, and active presets.",
      z.object({
        view,
        columns: z.array(id).max(100).nullable().optional(),
        timeFormat: z.enum(["12", "24"]).nullable().optional(),
        activeColumnPresetId: optionalId,
        activeSavedFilterId: optionalId,
      }),
      "saveHistoryViewSettings",
      undefined,
      "settings",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "sse_history_get_column_presets",
      "List saved SSE history column presets.",
      z.object({ view }),
      "historyColumnPresets",
      ({ view }) => [view],
      "presets",
    ),
    operation(
      service,
      "sse_history_save_column_preset",
      "Create or update an SSE history column preset.",
      z.object({
        id: optionalId,
        view,
        name: z.string().trim().min(1).max(200),
        columns: ids.min(1),
        isDefault: z.boolean().optional(),
      }),
      "saveHistoryColumnPreset",
      undefined,
      "preset",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "sse_history_delete_column_preset",
      "Delete an SSE history column preset.",
      identifier,
      "deleteHistoryColumnPreset",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      service,
      "sse_history_get_saved_filters",
      "List saved SSE history filters.",
      z.object({ view }),
      "historySavedFilters",
      ({ view }) => [view],
      "filters",
    ),
    operation(
      service,
      "sse_history_save_filter",
      "Create or update an SSE history saved filter.",
      z.object({
        id: optionalId,
        view,
        name: z.string().trim().min(1).max(200),
        definition: z.record(z.string(), z.unknown()),
      }),
      "saveHistorySavedFilter",
      undefined,
      "filter",
      WRITE_ANNOTATIONS,
    ),
    operation(
      service,
      "sse_history_delete_filter",
      "Delete an SSE history saved filter.",
      identifier,
      "deleteHistorySavedFilter",
      ({ id }) => [id],
      "deleted",
      DESTRUCTIVE_ANNOTATIONS,
    ),
  ];
}

export function createAgentAdministrationTools(
  service: Partial<AgentControlService>,
) {
  return [
    operation(
      service,
      "rename_agent",
      "Rename an enrolled agent.",
      z.object({ agentId: id, name: z.string().trim().min(1).max(200) }),
      "renameAgent",
      ({ agentId, name }) => [agentId, name],
      "agent",
      WRITE_ANNOTATIONS,
      (value) =>
        value && typeof value === "object"
          ? agentView(value as Record<string, unknown>)
          : null,
    ),
  ];
}

export function createUsageAdministrationTools(
  ccusage: Partial<CcusageService>,
  modelCosts: Partial<ModelCostsService>,
) {
  return [
    operation(
      ccusage,
      "clear_ccusage_history",
      "Clear historical usage collections.",
      empty,
      "clearHistory",
      () => [],
      "cleared",
      DESTRUCTIVE_ANNOTATIONS,
    ),
    operation(
      modelCosts,
      "save_model_cost_settings",
      "Set or reset the model pricing catalog source URL.",
      z.object({ catalogUrl: z.url().max(2000).nullable() }),
      "saveSettings",
      ({ catalogUrl }) => [catalogUrl],
      "catalog",
      WRITE_ANNOTATIONS,
    ),
  ];
}

export function createWorkflowQuickActionTools(
  service: Partial<WorkflowsService>,
) {
  return [
    operation(
      service,
      "set_workflow_quick_action",
      "Configure a workflow's quick-action placement and repository scope.",
      z.object({
        id,
        kind: z.enum([
          "STANDARD",
          "MERGE_CONFLICT",
          "GITHUB_ACTIONS",
          "GITLAB_PIPELINES",
          "NONE",
        ]),
        quickActionIconKey: id,
        quickActionButtonVariant: id,
        repositoryIds: ids,
      }),
      "setQuickAction",
      undefined,
      "workflow",
      WRITE_ANNOTATIONS,
      (value) =>
        value && typeof value === "object"
          ? workflowView(value as Record<string, unknown>)
          : null,
    ),
  ];
}
