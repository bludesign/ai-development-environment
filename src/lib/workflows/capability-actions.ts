import type { ConfigFieldDescriptor } from "./config-descriptor-types";

const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
const field = (
  key: string,
  control: ConfigFieldDescriptor["control"] = "text",
  required = false,
): ConfigFieldDescriptor => ({
  key,
  label: label(key),
  control,
  required: key === "requestId" ? false : required,
  ...(key === "requestId"
    ? {
        help: "Defaults to a stable identifier for this workflow run and step; retries reuse it.",
      }
    : {}),
  valueModes: ["literal", "session", "interpolation"],
  ...(control === "record" ? { recordValueType: "json" as const } : {}),
});
const choice = (
  key: string,
  values: string[],
  required = false,
): ConfigFieldDescriptor => ({
  ...field(key, "enum", required),
  options: {
    kind: "static",
    options: values.map((value) => ({ value, label: label(value) })),
  },
});

function action<const K extends string>(
  kind: K,
  category: string,
  toolName: string,
  fields: ConfigFieldDescriptor[],
  mutates = !/^(get_|search_|global_search|export_|preview_|inspect_)/.test(
    toolName,
  ),
) {
  return { kind, category, toolName, fields, label: label(toolName), mutates };
}

/**
 * Dedicated workflow actions backed by the same validated, authorized and
 * audited tools as MCP. Tool identity is fixed by code, never by workflow input.
 * The editor and published catalog share these operation-specific fields.
 */
export const WORKFLOW_CAPABILITY_ACTIONS = [
  action("SEARCH_GLOBAL", "Search", "global_search", [
    field("query", "text", true),
    field("firstPerGroup", "number"),
    field("relatedFirst", "number"),
  ]),
  action("ACTION_CENTER_LOAD", "Action Center", "get_action_center", [
    field("first", "number"),
    field("after", "text"),
    choice("surface", ["FULL", "SIDEBAR"]),
    field("resourceKinds", "stringList"),
  ]),
  action("APPS_LIST", "Apps", "get_apps", []),
  action("APP_LOAD", "Apps", "get_app", [field("id", "text", true)]),
  action("CLI_HEALTH_LOAD", "CLI Health", "get_agent_cli_health", [
    field("agentId", "text", true),
  ]),
  action("WORKTREE_LIST", "Worktrees", "get_worktrees", []),
  action("RUN_LIST", "Agent runs", "get_agent_runs", [
    choice("kind", ["SESSION", "PLAN"]),
    field("search", "text"),
    field("archive", "text"),
    field("provider", "text"),
    field("origin", "text"),
    field("first", "number"),
    field("after", "text"),
  ]),
  action("JIRA_BOARD_LOAD", "Jira", "get_jira_board", [
    field("sourceId", "text", true),
    field("refresh", "boolean"),
  ]),
  action("GITHUB_PR_LIST", "GitHub", "get_pull_requests", [
    choice("scope", ["MINE", "REVIEW_REQUESTED", "REPOSITORY"], true),
    field("repositoryId", "text"),
    choice("state", ["ALL", "OPEN", "CLOSED", "MERGED"]),
    field("first", "number"),
    field("after", "text"),
    field("includePipelineJobs", "boolean"),
  ]),
  action(
    "GITLAB_MR_LIST",
    "GitLab",
    "gitlab_get_merge_requests",
    [
      choice("scope", ["MINE", "REVIEW_REQUESTED", "PROJECT", "ALL"], true),
      field("projectId", "text"),
      choice("state", ["OPENED", "CLOSED", "MERGED", "ALL"]),
      field("page", "number"),
      field("perPage", "number"),
    ],
    false,
  ),
  action("AGENT_LIST", "Agents", "get_agents", []),
  action("CODEBASE_REGISTER", "Codebases", "register_codebase", [
    field("inspectionJobId", "text", true),
    field("name", "text"),
    field("description", "text"),
  ]),
  action("CODEBASE_REMOVE", "Codebases", "remove_codebase", [
    field("id", "text", true),
  ]),
  action(
    "CODEBASE_SAVE_REPOSITORY",
    "Codebases",
    "update_codebase_repository",
    [
      field("id", "text", true),
      field("name", "text", true),
      field("description", "text", true),
      field("jiraBranchRegex", "text"),
      field("keepBaseBranchUpToDate", "boolean", true),
      field("skillGroupIds", "stringList"),
    ],
  ),
  action("CODEBASE_SAVE_SETTINGS", "Codebases", "update_codebase_settings", [
    field("refreshIntervalSeconds", "number", true),
    field("fetchIntervalSeconds", "number", true),
    field("defaultJiraBranchRegex", "text", true),
  ]),
  action(
    "CODEBASE_SAVE_PREPARATIONS",
    "Codebases",
    "save_codebase_repository_preparations",
    [field("repositoryId", "text", true), field("preparations", "json", true)],
  ),
  action("CODEBASE_DELETE_BRANCHES", "Codebases", "delete_codebase_branches", [
    field("targets", "json", true),
    field("requestId", "text", true),
    field("force", "boolean"),
  ]),
  action("WORKTREE_REFRESH", "Worktrees", "refresh_worktrees", []),
  action("WORKTREE_SET_TAGS", "Worktrees", "set_worktree_tags", [
    field("id", "text", true),
    field("tagIds", "stringList", true),
  ]),
  action("BUILD_CREATE_PROJECT", "Builds", "create_build_project", [
    field("codebaseId", "text", true),
  ]),
  action("BUILD_SAVE_CONFIGURATION", "Builds", "save_build_configuration", [
    field("input", "json", true),
  ]),
  action("BUILD_DELETE_CONFIGURATION", "Builds", "delete_build_configuration", [
    field("id", "text", true),
  ]),
  action("BUILD_DISCOVER_SOURCES", "Builds", "discover_build_sources", [
    field("worktreeId", "text", true),
    field("requestId", "text", true),
  ]),
  action(
    "BUILD_INSPECT_SOURCE",
    "Builds",
    "inspect_build_source",
    [field("input", "json", true)],
    true,
  ),
  action("BUILD_SAVE_SCRIPT", "Builds", "save_build_script", [
    field("input", "json", true),
  ]),
  action("BUILD_DELETE_SCRIPT", "Builds", "delete_build_script", [
    field("id", "text", true),
  ]),
  action("COMMAND_CREATE", "Commands", "create_command", [
    field("name", "text", true),
    field("description", "text"),
    field("script", "text", true),
    choice(
      "targetKind",
      [
        "ANY_AGENT_HOME",
        "SPECIFIC_AGENT_HOME",
        "ANY_WORKTREE",
        "REPOSITORY_WORKTREE",
      ],
      true,
    ),
    field("targetAgentId", "text"),
    field("targetRepositoryIds", "stringList"),
    field("targetRepositoryId", "text"),
    choice("restartPolicy", ["NEVER", "ON_FAILURE", "ALWAYS"]),
    field("restartLimit", "number"),
    choice("concurrency", ["EXCLUSIVE", "NON_EXCLUSIVE", "EXCLUDED"]),
    field("blocksGitOperations", "boolean"),
    field("quickActionEnabled", "boolean"),
    field("quickActionIconKey", "text"),
    field("quickActionButtonVariant", "text"),
    field("notificationsEnabled", "boolean"),
  ]),
  action("COMMAND_UPDATE", "Commands", "update_command", [
    field("id", "text", true),
    field("input", "json", true),
  ]),
  action("COMMAND_ARCHIVE", "Commands", "archive_command", [
    field("id", "text", true),
    field("archived", "boolean"),
  ]),
  action("COMMAND_ARCHIVE_RUNS", "Commands", "archive_command_runs", [
    field("ids", "stringList", true),
    field("archived", "boolean"),
  ]),
  action("COMMAND_DELETE_RUNS", "Commands", "delete_command_runs", [
    field("ids", "stringList", true),
  ]),
  action("SKILL_SAVE", "Skills", "save_skill", [field("input", "json", true)]),
  action("SKILL_DELETE", "Skills", "delete_skill", [field("id", "text", true)]),
  action("SKILL_GROUP_SAVE", "Skills", "save_skill_group", [
    field("input", "json", true),
  ]),
  action("SKILL_GROUP_DELETE", "Skills", "delete_skill_group", [
    field("id", "text", true),
  ]),
  action("SKILL_UPDATE_SETTINGS", "Skills", "update_skill_settings", [
    field("input", "json", true),
  ]),
  action("AGENT_CANCEL_JOB", "Agents", "cancel_agent_job", [
    field("jobId", "text", true),
  ]),
  action(
    "AGENT_SET_REPOSITORY_DIRECTORY",
    "Agents",
    "update_agent_base_repo_directory",
    [field("agentId", "text", true), field("baseRepoDirectory", "text", true)],
  ),
  action(
    "AGENT_SET_BUILDS_DIRECTORY",
    "Agents",
    "update_agent_builds_directory",
    [field("agentId", "text", true), field("buildsDirectory", "text", true)],
  ),
  action(
    "AGENT_SET_DERIVED_DATA",
    "Agents",
    "update_agent_derived_data_settings",
    [
      field("agentId", "text", true),
      choice("mode", ["DEFAULT", "ABSOLUTE", "RELATIVE"], true),
      field("path", "text"),
    ],
  ),
  action("SIGNING_DOWNLOAD_PROFILE", "Signing", "download_signing_profile", [
    field("uuid", "text", true),
    field("agentId", "text", true),
  ]),
  action("SIGNING_DELETE_PROFILE", "Signing", "delete_signing_profile", [
    field("uuid", "text", true),
    field("agentIds", "stringList", true),
  ]),
  action(
    "BUILD_DATA_CALCULATE_SIZES",
    "Build Data",
    "calculate_build_data_sizes",
    [
      field("collectionId", "text", true),
      field("entryIds", "stringList", true),
      field("requestId", "text", true),
    ],
  ),
  action(
    "BUILD_DATA_CLEAR_HISTORY",
    "Build Data",
    "clear_build_data_history",
    [],
  ),
  action(
    "GITLAB_DELETE_AUTO_RETRY",
    "GitLab",
    "gitlab_delete_auto_retry_rule",
    [field("id", "text", true)],
  ),
  action("TELEMETRY_LOAD", "Telemetry", "get_unified_events", [
    field("first", "number"),
    field("after", "text"),
  ]),
  action("TELEMETRY_EXPORT", "Telemetry", "export_telemetry", [
    choice("view", ["UNIFIED", "CONSOLE", "ANALYTICS"]),
    field("search", "text"),
    field("first", "number"),
  ]),
  action(
    "TELEMETRY_UPDATE_SETTINGS",
    "Telemetry",
    "update_telemetry_settings",
    [
      field("localBaseUrlOverride", "text"),
      field("remoteBaseUrlOverride", "text"),
      field("consoleCollectionEnabled", "boolean"),
      field("analyticsCollectionEnabled", "boolean"),
    ],
  ),
  action(
    "NOTIFICATION_UPDATE_PREFERENCE",
    "Notifications",
    "update_notification_preference",
    [field("input", "json", true)],
  ),
  action("NOTIFICATION_DISMISS", "Notifications", "dismiss_notification", [
    field("id", "text", true),
  ]),
  action("CACHE_CLEAR_JIRA", "Cache", "clear_jira_cache", []),
  action("CACHE_CLEAR_GITHUB", "Cache", "clear_github_cache", []),
  action("CACHE_CLEAR_GITLAB", "Cache", "clear_gitlab_cache", []),
  action("CACHE_DELETE_ENTRIES", "Cache", "delete_cache_server_entries", [
    field("ids", "stringList", true),
  ]),
  action("RUN_CANCEL_QUESTION", "Agent runs", "cancel_run_question", [
    field("batchId", "text", true),
  ]),
  action("RUN_DRAFT_LIST", "Agent runs", "get_run_drafts", [
    field("search", "text"),
    choice("archive", ["ACTIVE", "ARCHIVED", "ALL"]),
    field("first", "number"),
    field("after", "text"),
  ]),
  action("RUN_DRAFT_LOAD", "Agent runs", "get_run_draft", [
    field("id", "text", true),
  ]),
  action("RUN_DRAFT_SAVE", "Agent runs", "save_run_draft", [
    field("input", "json", true),
  ]),
  action("RUN_DRAFT_ARCHIVE", "Agent runs", "archive_run_drafts", [
    field("ids", "stringList", true),
    field("archived", "boolean", true),
  ]),
  action("RUN_DRAFT_DELETE", "Agent runs", "delete_run_drafts", [
    field("ids", "stringList", true),
  ]),
  action(
    "RUN_PROVIDER_IMPORT_STATUS",
    "Agent runs",
    "get_run_provider_import_status",
    [],
  ),
  action("COMMAND_EXPORT", "Commands", "export_command", [
    field("id", "text", true),
  ]),
  action("COMMAND_IMPORT", "Commands", "import_command", [
    field("payload", "text", true),
    field("name", "text"),
  ]),
  action("COMMAND_DELETE", "Commands", "delete_command", [
    field("id", "text", true),
  ]),
  action(
    "BUILD_SIGNING_OPTIONS",
    "Builds",
    "get_build_signing_options",
    [field("buildId", "text", true)],
    true,
  ),
  action("BUILD_RUN_AGENTS", "Builds", "get_build_run_agents", [
    field("buildId", "text", true),
  ]),
  action(
    "BUILD_REPARSE_CONFIGURATION",
    "Builds",
    "reparse_build_configuration",
    [
      field("configurationId", "text", true),
      field("worktreeId", "text", true),
      field("requestId", "text", true),
    ],
  ),
  action("BUILD_DELETE_PROJECT", "Builds", "delete_build_project", [
    field("id", "text", true),
  ]),
  action("BUILD_SET_CODEBASE_SCRIPTS", "Builds", "set_codebase_build_scripts", [
    field("codebaseId", "text", true),
    field("scriptIds", "stringList", true),
  ]),
  action(
    "ACTION_CENTER_SETTINGS_LOAD",
    "Action Center",
    "get_action_center_settings",
    [],
  ),
  action(
    "ACTION_CENTER_SETTINGS_SAVE",
    "Action Center",
    "save_action_center_settings",
    [field("input", "json", true)],
  ),
  action("ACTION_CENTER_REFRESH", "Action Center", "refresh_action_center", []),
  action(
    "ACTION_CENTER_ACKNOWLEDGE",
    "Action Center",
    "acknowledge_action_center_item",
    [
      choice(
        "resourceKind",
        [
          "PLAN",
          "SESSION",
          "BUILD",
          "WORKFLOW",
          "PULL_REQUEST",
          "MERGE_REQUEST",
        ],
        true,
      ),
      field("resourceId", "text", true),
      field("failureFingerprint", "text", true),
    ],
  ),
  action(
    "ACTION_CENTER_DISMISS",
    "Action Center",
    "dismiss_action_center_item",
    [
      choice(
        "resourceKind",
        [
          "PLAN",
          "SESSION",
          "BUILD",
          "WORKFLOW",
          "PULL_REQUEST",
          "MERGE_REQUEST",
        ],
        true,
      ),
      field("resourceId", "text", true),
      field("dismissalFingerprint", "text", true),
    ],
  ),
  action("APP_CREATE", "Apps", "create_app", [
    field("name", "text", true),
    field("description", "text"),
    field("agentIds", "stringList"),
    field("repositoryIds", "stringList", true),
  ]),
  action("APP_UPDATE", "Apps", "update_app", [
    field("name", "text", true),
    field("description", "text"),
    field("agentIds", "stringList"),
    field("repositoryIds", "stringList", true),
    field("id", "text", true),
  ]),
  action("APP_DELETE", "Apps", "delete_app", [field("id", "text", true)]),
  action("CLI_HEALTH_RUN", "CLI Health", "run_cli_health_checks", [
    field("agentId", "text"),
  ]),
  action("CLI_HEALTH_SAVE_SETTINGS", "CLI Health", "save_cli_health_settings", [
    field("checks", "json", true),
  ]),
  action("CRASH_FACETS_LOAD", "Crashes", "get_crash_facets", []),
  action("DSYM_PROJECTS_LIST", "Crashes", "get_dsym_projects", []),
  action("CRASH_SETTINGS_LOAD", "Crashes", "get_crash_settings", []),
  action("CRASH_SETTINGS_UPDATE", "Crashes", "update_crash_settings", [
    field("collectionEnabled", "boolean"),
    field("symbolicationAgentId", "text"),
    field("retentionDays", "number"),
    field("dsymRetentionDays", "number"),
  ]),
  action(
    "CRASH_SYMBOLICATION_AGENTS",
    "Crashes",
    "get_crash_symbolication_agents",
    [],
  ),
  action("CRASH_SYMBOLICATE", "Crashes", "symbolicate_crash_report", [
    field("id", "text", true),
  ]),
  action("CRASH_DELETE_REPORTS", "Crashes", "delete_crash_reports", [
    field("ids", "stringList", true),
  ]),
  action("DSYM_DELETE", "Crashes", "delete_dsyms", [
    field("ids", "stringList", true),
  ]),
  action("DSYM_UPLOAD_LIST", "Crashes", "get_dsym_uploads", [
    field("statuses", "stringList"),
  ]),
  action("DSYM_UPLOAD_UPDATE", "Crashes", "update_dsym_upload", [
    field("id", "text", true),
    field("input", "json", true),
  ]),
  action("DSYM_UPLOAD_RETRY", "Crashes", "retry_dsym_upload", [
    field("id", "text", true),
  ]),
  action("DSYM_UPLOAD_DELETE", "Crashes", "delete_dsym_upload", [
    field("id", "text", true),
  ]),
  action(
    "REPOSITORY_TRANSFER_EXPORT_PREVIEW",
    "Repository transfer",
    "get_repository_transfer_export_preview",
    [field("input", "json", true)],
  ),
  action(
    "REPOSITORY_TRANSFER_EXPORT",
    "Repository transfer",
    "export_repository_transfer",
    [field("input", "json", true)],
  ),
  action(
    "REPOSITORY_TRANSFER_PREVIEW",
    "Repository transfer",
    "preview_repository_transfer",
    [field("input", "json", true)],
    true,
  ),
  action(
    "REPOSITORY_TRANSFER_APPLY",
    "Repository transfer",
    "apply_repository_transfer",
    [
      field("input", "json", true),
      field("fingerprint", "text", true),
      field("requestId", "text", true),
    ],
  ),
  action(
    "REPOSITORY_TRANSFER_LOAD",
    "Repository transfer",
    "get_repository_transfer_operation",
    [field("id", "text", true)],
  ),
  action(
    "REPOSITORY_TRANSFER_RETRY",
    "Repository transfer",
    "retry_repository_transfer",
    [field("id", "text", true), field("requestId", "text", true)],
  ),
  action(
    "APP_REPOSITORY_SYNC_LOAD",
    "Repository transfer",
    "get_app_repository_sync",
    [field("appId", "text", true)],
  ),
  action(
    "APP_REPOSITORY_SYNC",
    "Repository transfer",
    "sync_app_repositories",
    [
      field("appId", "text", true),
      field("destinations", "json", true),
      field("fingerprint", "text", true),
      field("requestId", "text", true),
    ],
  ),

  // Administrative operations share the validated MCP contracts.
  action(
    "SAVE_TELEMETRY_VIEW_SETTINGS",
    "Telemetry",
    "save_telemetry_view_settings",
    [
      choice("view", ["UNIFIED", "CONSOLE", "ANALYTICS"], true),
      field("columns", "stringList"),
      choice("timeFormat", ["12", "24"]),
      field("activeColumnPresetId", "text"),
      field("activeSavedFilterId", "text"),
    ],
  ),
  action("DELETE_TELEMETRY_PRESET", "Telemetry", "delete_telemetry_preset", [
    field("id", "text", true),
  ]),
  action("DELETE_TELEMETRY_FILTER", "Telemetry", "delete_telemetry_filter", [
    field("id", "text", true),
  ]),
  action("RENAME_AGENT", "Agents", "rename_agent", [
    field("agentId", "text", true),
    field("name", "text", true),
  ]),
  action("GET_WORKTREE_SETTINGS", "Worktrees", "get_worktree_settings", []),
  action("SAVE_WORKTREE_SETTINGS", "Worktrees", "save_worktree_settings", [
    choice("editorVariant", ["CODE", "CODE_INSIDERS", "NONE"], true),
  ]),
  action("SAVE_WORKTREE_TAG", "Worktrees", "save_worktree_tag", [
    field("id", "text"),
    field("name", "text", true),
    field("color", "text", true),
  ]),
  action("DELETE_WORKTREE_TAG", "Worktrees", "delete_worktree_tag", [
    field("id", "text", true),
  ]),
  action("PURGE_HIDDEN_WORKTREE", "Worktrees", "purge_hidden_worktree", [
    field("id", "text", true),
  ]),
  action(
    "PURGE_ALL_HIDDEN_WORKTREES",
    "Worktrees",
    "purge_all_hidden_worktrees",
    [],
  ),
  action(
    "PREVIEW_WORKTREE_TICKET_BRANCH",
    "Worktrees",
    "preview_worktree_ticket_branch",
    [
      field("codebaseId", "text", true),
      field("worktreeId", "text"),
      field("ticketKey", "text", true),
    ],
    true,
  ),
  action("GITLAB_GET_SETTINGS", "GitLab", "gitlab_get_settings", [], false),
  action("GITLAB_SAVE_PREFERENCES", "GitLab", "gitlab_save_preferences", [
    field("memberProjectsOnly", "boolean"),
    field("defaultSquash", "boolean"),
    field("defaultMoveTicketToDone", "boolean"),
    field("defaultDeleteWorktree", "boolean"),
  ]),
  action(
    "GET_GITHUB_AVAILABLE_REPOSITORIES",
    "GitHub",
    "get_github_available_repositories",
    [field("after", "text")],
  ),
  action("ADD_GITHUB_REPOSITORY", "GitHub", "add_github_repository", [
    field("nameWithOwner", "text", true),
    field("jiraKeyRegex", "text"),
  ]),
  action("UPDATE_GITHUB_REPOSITORY", "GitHub", "update_github_repository", [
    field("id", "text", true),
    field("jiraKeyRegex", "text"),
  ]),
  action("REMOVE_GITHUB_REPOSITORY", "GitHub", "remove_github_repository", [
    field("id", "text", true),
  ]),
  action(
    "SET_AUTO_RETRY_RULE_ENABLED",
    "GitHub",
    "set_auto_retry_rule_enabled",
    [field("id", "text", true), field("enabled", "boolean", true)],
  ),
  action("DELETE_AUTO_RETRY_RULE", "GitHub", "delete_auto_retry_rule", [
    field("id", "text", true),
  ]),
  action(
    "GET_GITHUB_WEBHOOK_DELIVERIES",
    "GitHub",
    "get_github_webhook_deliveries",
    [field("limit", "number"), field("offset", "number")],
  ),
  action(
    "CLEAR_GITHUB_WEBHOOK_DELIVERIES",
    "GitHub",
    "clear_github_webhook_deliveries",
    [],
  ),
  action(
    "GITLAB_GET_AVAILABLE_PROJECTS",
    "GitLab",
    "gitlab_get_available_projects",
    [
      field("search", "text"),
      field("page", "number"),
      field("perPage", "number"),
    ],
    false,
  ),
  action(
    "GITLAB_GET_ACCESSIBLE_PROJECTS",
    "GitLab",
    "gitlab_get_accessible_projects",
    [
      field("search", "text"),
      field("page", "number"),
      field("perPage", "number"),
    ],
    false,
  ),
  action("GITLAB_ADD_PROJECT", "GitLab", "gitlab_add_project", [
    field("projectId", "text", true),
  ]),
  action("GITLAB_REMOVE_PROJECT", "GitLab", "gitlab_remove_project", [
    field("projectId", "text", true),
    field("force", "boolean"),
  ]),
  action(
    "GITLAB_CONFIGURE_PROJECT_WEBHOOK",
    "GitLab",
    "gitlab_configure_project_webhook",
    [field("projectId", "text", true), field("callbackUrl", "text", true)],
  ),
  action(
    "GITLAB_REMOVE_PROJECT_WEBHOOK",
    "GitLab",
    "gitlab_remove_project_webhook",
    [field("projectId", "text", true)],
  ),
  action(
    "GITLAB_GET_MERGE_OPTIONS",
    "GitLab",
    "gitlab_get_merge_options",
    [
      field("projectId", "text", true),
      field("iid", "number", true),
      field("worktreeId", "text"),
    ],
    false,
  ),
  action("GITLAB_SUBMIT_MERGE", "GitLab", "gitlab_submit_merge", [
    field("projectId", "text", true),
    field("iid", "number", true),
    field("sha", "text", true),
    field("autoMerge", "boolean"),
    field("squash", "boolean"),
    field("removeSourceBranch", "boolean"),
    field("mergeCommitMessage", "text"),
    field("squashCommitMessage", "text"),
    field("worktreeId", "text"),
    field("deleteWorktree", "boolean"),
    field("moveTicketToDone", "boolean"),
  ]),
  action("GITLAB_CANCEL_AUTO_MERGE", "GitLab", "gitlab_cancel_auto_merge", [
    field("projectId", "text", true),
    field("iid", "number", true),
  ]),
  action(
    "GITLAB_RETRY_MERGE_FOLLOW_UPS",
    "GitLab",
    "gitlab_retry_merge_follow_ups",
    [field("projectId", "text", true), field("iid", "number", true)],
  ),
  action(
    "GITLAB_GET_MERGE_OPERATION",
    "GitLab",
    "gitlab_get_merge_operation",
    [field("projectId", "text", true), field("iid", "number", true)],
    false,
  ),
  action("GITLAB_RUN_PIPELINE_ACTION", "GitLab", "gitlab_run_pipeline_action", [
    field("projectId", "text", true),
    field("pipelineId", "text", true),
    choice("action", ["RETRY", "CANCEL"], true),
    field("jobId", "text"),
  ]),
  action(
    "GITLAB_GET_WEBHOOK_DELIVERIES",
    "GitLab",
    "gitlab_get_webhook_deliveries",
    [field("limit", "number"), field("offset", "number")],
    false,
  ),
  action(
    "GITLAB_GET_COMMENTS",
    "GitLab",
    "gitlab_get_comments",
    [
      field("projectId", "text"),
      field("iid", "number"),
      field("discussionId", "text"),
      field("after", "text"),
      field("first", "number"),
      field("refresh", "boolean"),
    ],
    false,
  ),
  action(
    "GET_EXTERNAL_PIPELINE_ACTIONS",
    "GitLab",
    "get_external_pipeline_actions",
    [field("repositoryId", "text", true)],
  ),
  action(
    "SAVE_EXTERNAL_PIPELINE_ACTIONS",
    "GitLab",
    "save_external_pipeline_actions",
    [
      field("repositoryId", "text", true),
      field("enabled", "boolean", true),
      field("retryScript", "text", true),
      field("cancelScript", "text", true),
    ],
  ),
  action(
    "GET_EXTERNAL_PIPELINE_EXECUTIONS",
    "GitLab",
    "get_external_pipeline_executions",
    [field("projectId", "text", true), field("pipelineId", "text", true)],
  ),
  action(
    "GET_WEB_PUSH_SUBSCRIPTIONS",
    "Notifications",
    "get_web_push_subscriptions",
    [],
  ),
  action("PREPARE_WEB_PUSH", "Notifications", "prepare_web_push", []),
  action(
    "DELETE_WEB_PUSH_SUBSCRIPTION",
    "Notifications",
    "delete_web_push_subscription",
    [field("id", "text", true)],
  ),
  action(
    "GET_NOTIFICATION_APNS_STATUS",
    "Notifications",
    "get_notification_apns_status",
    [],
  ),
  action(
    "GET_NOTIFICATION_DEVICES",
    "Notifications",
    "get_notification_devices",
    [],
  ),
  action(
    "RENAME_NOTIFICATION_DEVICE",
    "Notifications",
    "rename_notification_device",
    [field("id", "text", true), field("displayName", "text", true)],
  ),
  action(
    "DELETE_NOTIFICATION_DEVICE",
    "Notifications",
    "delete_notification_device",
    [field("id", "text", true)],
  ),
  action(
    "TEST_NOTIFICATION_DEVICE",
    "Notifications",
    "test_notification_device",
    [field("id", "text", true)],
  ),
  action("CLEAR_CCUSAGE_HISTORY", "Tools", "clear_ccusage_history", []),
  action("SAVE_MODEL_COST_SETTINGS", "Tools", "save_model_cost_settings", [
    field("catalogUrl", "text", true),
  ]),
  action("GET_CACHE_SERVER_SETTINGS", "Cache", "get_cache_server_settings", []),
  action("SAVE_CACHE_SERVER_SETTINGS", "Cache", "save_cache_server_settings", [
    field("baseUrl", "text", true),
    field("headers", "json"),
  ]),
  action(
    "TEST_CACHE_SERVER_CONNECTION",
    "Cache",
    "test_cache_server_connection",
    [],
    false,
  ),
  action(
    "DELETE_CACHE_SERVER_ENTRIES_BY_FILTER",
    "Cache",
    "delete_cache_server_entries_by_filter",
    [
      field("key", "text"),
      field("version", "text"),
      field("scope", "text"),
      field("repoId", "text"),
    ],
  ),
  action(
    "DELETE_CACHE_STORAGE_LOCATION",
    "Cache",
    "delete_cache_storage_location",
    [field("id", "text", true)],
  ),
  action("GET_JIRA_CACHED_TICKET", "Cache", "get_jira_cached_ticket", [
    field("issueKey", "text", true),
  ]),
  action("CLEAR_JIRA_API_CALLS", "Tools", "clear_jira_api_calls", []),
  action(
    "REFRESH_GITHUB_CACHED_ENTRY",
    "GitHub",
    "refresh_github_cached_entry",
    [field("id", "text", true)],
  ),
  action("CLEAR_GITHUB_API_CALLS", "GitHub", "clear_github_api_calls", []),
  action("CREATE_MCP_TOOL_PRESET", "Tools", "create_mcp_tool_preset", [
    field("input", "json", true),
  ]),
  action("UPDATE_MCP_TOOL_PRESET", "Tools", "update_mcp_tool_preset", [
    field("id", "text", true),
    field("input", "json", true),
  ]),
  action("DELETE_MCP_TOOL_PRESET", "Tools", "delete_mcp_tool_preset", [
    field("id", "text", true),
  ]),
  action("EXPORT_MCP_TOOL_CATALOG", "Tools", "export_mcp_tool_catalog", [
    choice("format", ["JSON", "MARKDOWN"], true),
    choice("source", ["ALL", "BUILTIN", "EXTERNAL"]),
    field("groupIds", "stringList"),
  ]),
  action("EXPORT_MCP_TOOL_PRESETS", "Tools", "export_mcp_tool_presets", [
    field("ids", "stringList", true),
  ]),
  action(
    "PREVIEW_MCP_TOOL_PRESET_IMPORT",
    "Tools",
    "preview_mcp_tool_preset_import",
    [field("input", "json", true)],
  ),
  action("IMPORT_MCP_TOOL_PRESETS", "Tools", "import_mcp_tool_presets", [
    field("input", "json", true),
    field("previewToken", "text", true),
  ]),
  action("GET_EXTERNAL_MCP_SERVERS", "Tools", "get_external_mcp_servers", []),
  action("CREATE_EXTERNAL_MCP_SERVER", "Tools", "create_external_mcp_server", [
    field("input", "json", true),
  ]),
  action("UPDATE_EXTERNAL_MCP_SERVER", "Tools", "update_external_mcp_server", [
    field("id", "text", true),
    field("input", "json", true),
  ]),
  action("DELETE_EXTERNAL_MCP_SERVER", "Tools", "delete_external_mcp_server", [
    field("id", "text", true),
  ]),
  action("CLEAR_TOOL_CALL_HISTORY", "Tools", "clear_tool_call_history", []),
  action("GET_MCP_TOOL_PRESETS", "Tools", "get_mcp_tool_presets", [
    choice("kind", ["PLAN", "SESSION"]),
  ]),
  action(
    "TEST_EXTERNAL_MCP_SERVER",
    "Tools",
    "test_external_mcp_server",
    [field("id", "text", true)],
    false,
  ),
  action("GET_TOOL_CALL_HISTORY", "Tools", "get_tool_call_history", [
    field("first", "number"),
    field("toolName", "text"),
    choice("resultStatus", ["RUNNING", "SUCCEEDED", "FAILED"]),
  ]),
  action("GET_TOOL_CALL", "Tools", "get_tool_call", [
    field("id", "text", true),
  ]),
  action("SET_WORKFLOW_QUICK_ACTION", "Tools", "set_workflow_quick_action", [
    field("id", "text", true),
    choice(
      "kind",
      [
        "STANDARD",
        "MERGE_CONFLICT",
        "GITHUB_ACTIONS",
        "GITLAB_PIPELINES",
        "NONE",
      ],
      true,
    ),
    field("quickActionIconKey", "text", true),
    field("quickActionButtonVariant", "text", true),
    field("repositoryIds", "stringList", true),
  ]),
  action(
    "SSE_HISTORY_GET_VIEW_SETTINGS",
    "SSE",
    "sse_history_get_view_settings",
    [choice("view", ["STREAMS", "EVENTS"], true)],
    false,
  ),
  action(
    "SSE_HISTORY_SAVE_VIEW_SETTINGS",
    "SSE",
    "sse_history_save_view_settings",
    [
      choice("view", ["STREAMS", "EVENTS"], true),
      field("columns", "stringList"),
      choice("timeFormat", ["12", "24"]),
      field("activeColumnPresetId", "text"),
      field("activeSavedFilterId", "text"),
    ],
  ),
  action(
    "SSE_HISTORY_GET_COLUMN_PRESETS",
    "SSE",
    "sse_history_get_column_presets",
    [choice("view", ["STREAMS", "EVENTS"], true)],
    false,
  ),
  action(
    "SSE_HISTORY_SAVE_COLUMN_PRESET",
    "SSE",
    "sse_history_save_column_preset",
    [
      field("id", "text"),
      choice("view", ["STREAMS", "EVENTS"], true),
      field("name", "text", true),
      field("columns", "stringList", true),
      field("isDefault", "boolean"),
    ],
  ),
  action(
    "SSE_HISTORY_DELETE_COLUMN_PRESET",
    "SSE",
    "sse_history_delete_column_preset",
    [field("id", "text", true)],
  ),
  action(
    "SSE_HISTORY_GET_SAVED_FILTERS",
    "SSE",
    "sse_history_get_saved_filters",
    [choice("view", ["STREAMS", "EVENTS"], true)],
    false,
  ),
  action("SSE_HISTORY_SAVE_FILTER", "SSE", "sse_history_save_filter", [
    field("id", "text"),
    choice("view", ["STREAMS", "EVENTS"], true),
    field("name", "text", true),
    field("definition", "json", true),
  ]),
  action("SSE_HISTORY_DELETE_FILTER", "SSE", "sse_history_delete_filter", [
    field("id", "text", true),
  ]),

  action("SEARCH_UNIFIED_EVENTS", "Telemetry", "search_unified_events", [
    field("first", "number"),
    field("after", "text"),
    field("search", "text"),
    choice("searchMode", ["TEXT", "GLOB", "REGEX"]),
    field("caseSensitive", "boolean"),
    field("quickFilters", "json"),
    field("advancedFilter", "json"),
  ]),
  action("UPDATE_JIRA_CACHE_TTL", "Cache", "update_jira_cache_ttl", [
    field("ttlMinutes", "number", true),
  ]),
  action("GET_GITHUB_SETTINGS", "GitHub", "get_github_settings", []),
  action("SAVE_GITHUB_PREFERENCES", "GitHub", "save_github_preferences", [
    choice("defaultMergeMethod", ["MERGE", "SQUASH", "REBASE"]),
    field("emptyMergeCommitDescription", "boolean"),
    field("defaultMoveTicketToDone", "boolean"),
    field("defaultDeleteWorktree", "boolean"),
    field("defaultJiraKeyRegex", "text"),
    field("actionsNotificationPollIntervalSeconds", "number"),
  ]),
  action(
    "GITLAB_UPDATE_CONNECTION_SETTINGS",
    "GitLab",
    "gitlab_update_connection_settings",
    [
      field("baseUrl", "text", true),
      field("pipelinePollIntervalSeconds", "number"),
    ],
  ),
  action("GET_GITHUB_CACHED_ENTRY", "Cache", "get_github_cached_entry", [
    field("id", "text", true),
  ]),
  action("DELETE_GITHUB_CACHED_ENTRY", "Cache", "delete_github_cached_entry", [
    field("id", "text", true),
  ]),
  action(
    "GET_GITHUB_CACHE_TTL_OVERRIDES",
    "Cache",
    "get_github_cache_ttl_overrides",
    [],
  ),
  action("UPDATE_GITHUB_CACHE_TTL", "Cache", "update_github_cache_ttl", [
    field("ttlMinutes", "number", true),
  ]),
  action(
    "SAVE_GITHUB_CACHE_TTL_OVERRIDE",
    "Cache",
    "save_github_cache_ttl_override",
    [field("operation", "text", true), field("ttlSeconds", "number", true)],
  ),
  action(
    "DELETE_GITHUB_CACHE_TTL_OVERRIDE",
    "Cache",
    "delete_github_cache_ttl_override",
    [field("operation", "text", true)],
  ),
  action("GET_GITLAB_CACHED_ENTRY", "Cache", "get_gitlab_cached_entry", [
    field("id", "text", true),
  ]),
  action("DELETE_GITLAB_CACHED_ENTRY", "Cache", "delete_gitlab_cached_entry", [
    field("id", "text", true),
  ]),
  action(
    "GET_GITLAB_CACHE_TTL_OVERRIDES",
    "Cache",
    "get_gitlab_cache_ttl_overrides",
    [],
  ),
  action("UPDATE_GITLAB_CACHE_TTL", "Cache", "update_gitlab_cache_ttl", [
    field("ttlMinutes", "number", true),
  ]),
  action(
    "SAVE_GITLAB_CACHE_TTL_OVERRIDE",
    "Cache",
    "save_gitlab_cache_ttl_override",
    [field("operation", "text", true), field("ttlSeconds", "number", true)],
  ),
  action(
    "DELETE_GITLAB_CACHE_TTL_OVERRIDE",
    "Cache",
    "delete_gitlab_cache_ttl_override",
    [field("operation", "text", true)],
  ),

  action("GET_CRASH_REPORTS", "Crashes", "get_crash_reports", [
    field("first", "number"),
    field("after", "text"),
    field("filter", "json"),
  ]),
  action("GET_CRASH_REPORT", "Crashes", "get_crash_report", [
    field("id", "text", true),
  ]),
  action("GET_DSYMS", "Crashes", "get_dsyms", [
    field("first", "number"),
    field("after", "text"),
    field("filter", "json"),
  ]),
  action("GET_DSYM", "Crashes", "get_dsym", [field("id", "text", true)]),
  action("GET_TELEMETRY_PRESETS", "Telemetry", "get_telemetry_presets", [
    choice("view", ["UNIFIED", "CONSOLE", "ANALYTICS"], true),
  ]),
  action("SAVE_TELEMETRY_PRESET", "Telemetry", "save_telemetry_preset", [
    field("input", "json", true),
  ]),
  action(
    "GET_SAVED_TELEMETRY_FILTERS",
    "Telemetry",
    "get_saved_telemetry_filters",
    [choice("view", ["UNIFIED", "CONSOLE", "ANALYTICS"], true)],
  ),
  action("SAVE_TELEMETRY_FILTER", "Telemetry", "save_telemetry_filter", [
    field("input", "json", true),
  ]),
  action("GET_COMMANDS", "Commands", "get_commands", [
    field("includeArchived", "boolean"),
  ]),
  action("GET_COMMAND", "Commands", "get_command", [field("id", "text", true)]),
  action("GET_COMMAND_RUNS", "Commands", "get_command_runs", [
    field("includeArchived", "boolean"),
    field("search", "text"),
    field("agentId", "text"),
    field("worktreeId", "text"),
    field("first", "number"),
    field("after", "text"),
  ]),
  action(
    "TEST_WEB_PUSH_SUBSCRIPTION",
    "Notifications",
    "test_web_push_subscription",
    [field("id", "text", true)],
  ),
  action(
    "GET_GITHUB_CACHEABLE_OPERATIONS",
    "GitHub",
    "get_github_cacheable_operations",
    [],
  ),
] as const;

export type WorkflowCapabilityAction =
  (typeof WORKFLOW_CAPABILITY_ACTIONS)[number];
export const WORKFLOW_CAPABILITY_ACTION_KINDS = WORKFLOW_CAPABILITY_ACTIONS.map(
  ({ kind }) => kind,
);
