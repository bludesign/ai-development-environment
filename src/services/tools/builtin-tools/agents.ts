import * as z from "zod/v4";

import type { AgentControlService } from "@/services/agent-control";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";
import {
  agentJobLogView,
  agentJobView,
  agentSettingsView,
  agentView,
} from "../builtin-views";

const EmptyInputSchema = z.object({});
const AgentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  version: z.string(),
  osVersion: z.string(),
  architecture: z.string(),
  cpuModel: z.string().nullable(),
  memoryTotalBytes: z.number().nullable(),
  memoryFreeBytes: z.number().nullable(),
  diskTotalBytes: z.number().nullable(),
  diskFreeBytes: z.number().nullable(),
  capabilities: z.array(z.string()),
  baseRepoDirectory: z.string().nullable(),
  derivedDataLocationMode: z.enum(["DEFAULT", "ABSOLUTE", "RELATIVE"]),
  derivedDataPath: z.string().nullable(),
  buildsDirectory: z.string().nullable(),
  defaultBuildsDirectory: z.string().nullable(),
  effectiveBuildsDirectory: z.string().nullable(),
  connectionStatus: z.enum(["ONLINE", "OFFLINE"]),
  ipAddress: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  disconnectedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const AgentSettingsSchema = z.object({
  agentId: z.string(),
  baseRepoDirectory: z.string().nullable(),
  buildsDirectory: z.string().nullable(),
  defaultBuildsDirectory: z.string().nullable(),
  effectiveBuildsDirectory: z.string().nullable(),
  derivedDataLocationMode: z.enum(["DEFAULT", "ABSOLUTE", "RELATIVE"]),
  derivedDataPath: z.string().nullable(),
  updatedAt: z.string(),
});
const AgentJobSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  worktreeId: z.string().nullable(),
  codebaseId: z.string().nullable(),
  kind: z.string(),
  payload: z.unknown(),
  status: z.string(),
  idempotencyKey: z.string(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  timeoutSeconds: z.number().int(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
const AgentJobLogSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  sequence: z.number().int(),
  stream: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
const AgentIdInputSchema = z.object({ agentId: z.string().min(1) });

export function createAgentToolGroup(
  agents: AgentControlService,
): BuiltInToolGroup {
  return {
    id: "builtin:agents",
    name: "Agents",
    children: [],
    tools: [
      defineTool({
        name: "get_agents",
        title: "Get agents",
        description:
          "List enrolled agents, capabilities, resources, and status.",
        inputSchema: EmptyInputSchema,
        outputSchema: z.object({ agents: z.array(AgentViewSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({
          agents: (await agents.listAgents()).map((agent) =>
            agentView(agent as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "get_agent",
        title: "Get agent",
        description: "Get one enrolled agent by ID.",
        inputSchema: AgentIdInputSchema,
        outputSchema: z.object({ agent: AgentViewSchema.nullable() }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ agentId }) => {
          const agent = await agents.getAgent(agentId);
          return {
            agent: agent
              ? agentView(agent as unknown as Record<string, unknown>)
              : null,
          };
        },
      }),
      defineTool({
        name: "get_agent_settings",
        title: "Get agent settings",
        description:
          "Get repository, build, and Derived Data paths for an agent.",
        inputSchema: AgentIdInputSchema,
        outputSchema: z.object({ settings: AgentSettingsSchema }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ agentId }) => {
          const agent = await agents.getAgent(agentId);
          if (!agent) throw new Error("Agent not found");
          return {
            settings: agentSettingsView(
              agent as unknown as Record<string, unknown>,
            ),
          };
        },
      }),
      defineTool({
        name: "get_agent_jobs",
        title: "Get agent jobs",
        description: "List recent user-visible jobs for an agent.",
        inputSchema: z.object({
          agentId: z.string().min(1),
          limit: z.number().int().min(1).max(200).default(50),
        }),
        outputSchema: z.object({ jobs: z.array(AgentJobSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ agentId, limit }) => ({
          jobs: (await agents.listJobs(agentId, limit)).map((job) =>
            agentJobView(job as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "get_agent_job",
        title: "Get agent job",
        description: "Get one agent job and its result by ID.",
        inputSchema: z.object({ jobId: z.string().min(1) }),
        outputSchema: z.object({ job: AgentJobSchema.nullable() }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ jobId }) => {
          const job = await agents.getJob(jobId);
          return {
            job: job
              ? agentJobView(job as unknown as Record<string, unknown>)
              : null,
          };
        },
      }),
      defineTool({
        name: "get_agent_job_logs",
        title: "Get agent job logs",
        description:
          "Fetch ordered job logs after an optional sequence number.",
        inputSchema: z.object({
          jobId: z.string().min(1),
          afterSequence: z.number().int().min(-1).default(-1),
        }),
        outputSchema: z.object({ logs: z.array(AgentJobLogSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ jobId, afterSequence }) => ({
          logs: (await agents.listLogs(jobId, afterSequence)).map((log) =>
            agentJobLogView(log as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "update_agent_base_repo_directory",
        title: "Update agent base repository directory",
        description: "Set or reset the absolute base repository directory.",
        inputSchema: z.object({
          agentId: z.string().min(1),
          baseRepoDirectory: z.string().min(1).nullable(),
        }),
        outputSchema: z.object({ settings: AgentSettingsSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ agentId, baseRepoDirectory }) => ({
          settings: agentSettingsView(
            (await agents.updateBaseRepoDirectory(
              agentId,
              baseRepoDirectory,
            )) as unknown as Record<string, unknown>,
          ),
        }),
      }),
      defineTool({
        name: "update_agent_builds_directory",
        title: "Update agent builds directory",
        description: "Set or reset the absolute build-output directory.",
        inputSchema: z.object({
          agentId: z.string().min(1),
          buildsDirectory: z.string().min(1).nullable(),
        }),
        outputSchema: z.object({ settings: AgentSettingsSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ agentId, buildsDirectory }) => ({
          settings: agentSettingsView(
            (await agents.updateBuildsDirectory(
              agentId,
              buildsDirectory,
            )) as unknown as Record<string, unknown>,
          ),
        }),
      }),
      defineTool({
        name: "update_agent_derived_data_settings",
        title: "Update agent Derived Data settings",
        description:
          "Set default, absolute, or worktree-relative Derived Data paths.",
        inputSchema: z.object({
          agentId: z.string().min(1),
          mode: z.enum(["DEFAULT", "ABSOLUTE", "RELATIVE"]),
          path: z.string().min(1).nullable().default(null),
        }),
        outputSchema: z.object({ settings: AgentSettingsSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ agentId, mode, path }) => ({
          settings: agentSettingsView(
            (await agents.updateDerivedDataSettings(
              agentId,
              mode,
              path,
            )) as unknown as Record<string, unknown>,
          ),
        }),
      }),
      defineTool({
        name: "request_agent_codebase_reconcile",
        title: "Request agent codebase reconcile",
        description:
          "Ask an online agent to reconcile its registered codebases.",
        inputSchema: AgentIdInputSchema,
        outputSchema: z.object({ requested: z.boolean() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ agentId }) => ({
          requested: (await agents.requestCodebaseReconcile([agentId])) === 1,
        }),
      }),
      defineTool({
        name: "cancel_agent_job",
        title: "Cancel agent job",
        description: "Cancel a queued or running agent job.",
        inputSchema: z.object({ jobId: z.string().min(1) }),
        outputSchema: z.object({ job: AgentJobSchema }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ jobId }) => ({
          job: agentJobView(
            (await agents.cancelJob(jobId)) as unknown as Record<
              string,
              unknown
            >,
          ),
        }),
      }),
    ],
  };
}
