import * as z from "zod/v4";

import type { ActionCenterService } from "@/services/action-center";
import type { AppsService } from "@/services/apps";
import type { CliHealthService } from "@/services/cli-health";
import type { GlobalSearchService } from "@/services/global-search";

import { defineTool, type BuiltInToolGroup } from "../builtin-tools";
import {
  ActionCenterPageSchema,
  AgentCliHealthSchema,
  InstallationStatusSchema,
  SearchResultsSchema,
} from "./discovery-schemas";

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
          "List active work, pending questions, blocked or failed runs, and builds awaiting action, with cursor pagination.",
        inputSchema: z.object({
          first: z.number().int().min(1).max(200).default(50),
          after: z.string().max(4096).nullable().optional(),
        }),
        outputSchema: z.object({ page: ActionCenterPageSchema }),
        handler: async (input) => ({ page: await service.list(input) }),
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
    ],
  };
}
