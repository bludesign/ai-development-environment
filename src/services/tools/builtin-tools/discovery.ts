import * as z from "zod/v4";

import type { ActionCenterService } from "@/services/action-center";
import type { AppsService } from "@/services/apps";
import type { CliHealthService } from "@/services/cli-health";
import type { GlobalSearchService } from "@/services/global-search";

import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";
import {
  ActionCenterPageSchema,
  AgentCliHealthSchema,
  InstallationStatusSchema,
  SearchResultsSchema,
} from "./discovery-schemas";

const Id = z.string().trim().min(1).max(256);
const ResourceKind = z.enum([
  "PLAN",
  "SESSION",
  "BUILD",
  "WORKFLOW",
  "PULL_REQUEST",
  "MERGE_REQUEST",
]);
const ActionSettings = z.object({
  maximumRequestAgeDays: z.number().int().min(0),
  showMyRequestsInSidebar: z.boolean(),
  showReviewRequestsInSidebar: z.boolean(),
});
const AppInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  agentIds: z.array(Id).max(500).default([]),
  repositoryIds: z.array(Id).min(1).max(500),
});

export function createSearchToolGroup(
  service: GlobalSearchService,
): BuiltInToolGroup {
  return {
    id: "builtin:search",
    name: "Search",
    children: [],
    tools: [
      defineTool({
        name: "global_search",
        title: "Search the development environment",
        description:
          "Find worktrees, tickets, pull requests, repositories, builds, runs, commands, skills, and devices across the development environment.",
        inputSchema: z.object({
          query: z.string().trim().min(1).max(200),
          firstPerGroup: z.number().int().min(1).max(10).default(5),
          relatedFirst: z.number().int().min(0).max(5).default(3),
        }),
        outputSchema: z.object({ results: SearchResultsSchema }),
        handler: async ({ query, firstPerGroup, relatedFirst }) => ({
          results: await service.search(query, firstPerGroup, relatedFirst),
        }),
      }),
    ],
  };
}

export function createActionCenterToolGroup(
  service: ActionCenterService,
): BuiltInToolGroup {
  return {
    id: "builtin:action-center",
    name: "Action Center",
    children: [],
    tools: [
      defineTool({
        name: "get_action_center",
        title: "Get action center",
        description:
          "List active work, pending questions, blocked or failed runs, builds awaiting action, and pull/merge requests, with cursor pagination.",
        inputSchema: z.object({
          first: z.number().int().min(1).max(200).default(50),
          after: z.string().max(4096).nullable().optional(),
          surface: z.enum(["FULL", "SIDEBAR"]).optional(),
          resourceKinds: z.array(ResourceKind).max(6).optional(),
        }),
        outputSchema: z.object({ page: ActionCenterPageSchema }),
        handler: async (input) => ({ page: await service.list(input) }),
      }),
      defineTool({
        name: "get_action_center_settings",
        title: "Get action center settings",
        description: "Read shared request discovery and sidebar preferences.",
        inputSchema: z.object({}),
        outputSchema: z.object({ settings: ActionSettings }),
        handler: async () => ({ settings: await service.settings() }),
      }),
      defineTool({
        name: "save_action_center_settings",
        title: "Save action center settings",
        description:
          "Replace shared request discovery and sidebar preferences.",
        inputSchema: z.object({ input: ActionSettings }),
        outputSchema: z.object({ settings: ActionSettings }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ input }) => ({
          settings: await service.saveSettings(input),
        }),
      }),
      defineTool({
        name: "refresh_action_center",
        title: "Refresh action center",
        description:
          "Refresh the local request index using configured provider caches.",
        inputSchema: z.object({}),
        outputSchema: z.object({ refreshed: z.boolean() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async () => ({ refreshed: await service.refresh() }),
      }),
      defineTool({
        name: "acknowledge_action_center_item",
        title: "Acknowledge action center item",
        description:
          "Acknowledge the exact failure fingerprint returned by get_action_center.",
        inputSchema: z.object({
          resourceKind: ResourceKind,
          resourceId: Id,
          failureFingerprint: z.string().min(1).max(4096),
        }),
        outputSchema: z.object({ acknowledged: z.boolean() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          acknowledged: await service.acknowledge(input),
        }),
      }),
      defineTool({
        name: "dismiss_action_center_item",
        title: "Dismiss action center item",
        description:
          "Dismiss the exact dismissal fingerprint returned by get_action_center.",
        inputSchema: z.object({
          resourceKind: ResourceKind,
          resourceId: Id,
          dismissalFingerprint: z.string().min(1).max(4096),
        }),
        outputSchema: z.object({ dismissed: z.boolean() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({ dismissed: await service.dismiss(input) }),
      }),
    ],
  };
}

const AppSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  agentIds: z.array(z.string()),
  repositories: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string() }),
  ),
  counts: z.object({
    repositories: z.number().int(),
    codebases: z.number().int(),
    worktrees: z.number().int(),
    dirtyWorktrees: z.number().int(),
    nonMainWorktrees: z.number().int(),
    openRequests: z.number().int(),
    plans: z.number().int(),
    sessions: z.number().int(),
    builds: z.number().int(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function appView(app: NonNullable<Awaited<ReturnType<AppsService["get"]>>>) {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    agentIds: app.agentIds,
    repositories: app.repositories.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    counts: app.counts,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

export function createAppsToolGroup(service: AppsService): BuiltInToolGroup {
  return {
    id: "builtin:apps",
    name: "Apps",
    children: [],
    tools: [
      defineTool({
        name: "get_apps",
        title: "Get apps",
        description:
          "List product groupings with repository IDs and resource counts, without nested agent configuration.",
        inputSchema: z.object({}),
        outputSchema: z.object({ apps: z.array(AppSchema) }),
        handler: async () => ({ apps: (await service.list()).map(appView) }),
      }),
      defineTool({
        name: "get_app",
        title: "Get app",
        description:
          "Get one product grouping with its repository IDs and resource counts. Returns null when the app does not exist.",
        inputSchema: z.object({ id: z.string().min(1).max(256) }),
        outputSchema: z.object({ app: AppSchema.nullable() }),
        handler: async ({ id }) => {
          const app = await service.get(id);
          return { app: app ? appView(app) : null };
        },
      }),
      defineTool({
        name: "create_app",
        title: "Create app",
        description:
          "Create a product grouping with selected repositories and agents.",
        inputSchema: AppInput,
        outputSchema: z.object({ app: AppSchema }),
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
        handler: async (input) => ({
          app: appView(await service.create(input)),
        }),
      }),
      defineTool({
        name: "update_app",
        title: "Update app",
        description:
          "Replace an app's name, description, and repository and agent memberships.",
        inputSchema: AppInput.extend({ id: Id }),
        outputSchema: z.object({ app: AppSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          app: appView(await service.update(input)),
        }),
      }),
      defineTool({
        name: "delete_app",
        title: "Delete app",
        description:
          "Delete an app grouping without deleting its repositories.",
        inputSchema: z.object({ id: Id }),
        outputSchema: z.object({ app: z.object({ id: z.string() }) }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ id }) => ({ app: await service.delete(id) }),
      }),
    ],
  };
}

export function createCliHealthToolGroup(
  service: CliHealthService,
): BuiltInToolGroup {
  return {
    id: "builtin:cli-health",
    name: "CLI Health",
    children: [],
    tools: [
      defineTool({
        name: "get_installation_status",
        title: "Get installation status",
        description:
          "Read installed component versions and cached CLI health for registered agents. Does not execute health checks.",
        inputSchema: z.object({}),
        outputSchema: z.object({ status: InstallationStatusSchema }),
        handler: async () => ({ status: await service.installationStatus() }),
      }),
      defineTool({
        name: "get_agent_cli_health",
        title: "Get agent CLI health",
        description:
          "Read the latest cached CLI health checks for one agent, including check failures and version information.",
        inputSchema: z.object({ agentId: z.string().min(1).max(256) }),
        outputSchema: z.object({ status: AgentCliHealthSchema }),
        handler: async ({ agentId }) => ({
          status: await service.statusForAgent(agentId),
        }),
      }),
      defineTool({
        name: "run_cli_health_checks",
        title: "Run CLI health checks",
        description:
          "Queue shell-based health checks for one agent or all eligible online agents.",
        inputSchema: z.object({ agentId: Id.nullable().optional() }),
        outputSchema: z.object({ status: InstallationStatusSchema }),
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
        handler: async ({ agentId }) => ({
          status: await service.run(agentId),
        }),
      }),
      defineTool({
        name: "save_cli_health_settings",
        title: "Save CLI health settings",
        description:
          "Replace the complete ordered custom shell-check definitions. Omitted checks are removed.",
        inputSchema: z.object({
          checks: z
            .array(
              z.object({
                id: z.string().min(1).max(100).optional(),
                name: z.string().trim().min(1).max(100),
                command: z.string().trim().min(1).max(4096),
                enabled: z.boolean().default(true),
              }),
            )
            .max(20),
        }),
        outputSchema: z.object({ status: InstallationStatusSchema }),
        annotations: { ...DESTRUCTIVE_ANNOTATIONS, idempotentHint: false },
        handler: async ({ checks }) => ({
          status: await service.saveSettings(checks),
        }),
      }),
    ],
  };
}
