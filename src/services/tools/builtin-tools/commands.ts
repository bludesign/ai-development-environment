import * as z from "zod/v4";

import type { CommandsService } from "@/services/commands";

import {
  DESTRUCTIVE_ANNOTATIONS,
  defineTool,
  WRITE_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import {
  invokeService,
  redactSensitiveToolOutput,
  serviceTool,
} from "./service-tool";

const definitionInput = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  script: z.string().min(1),
  targetKind: z.enum([
    "ANY_AGENT_HOME",
    "SPECIFIC_AGENT_HOME",
    "ANY_WORKTREE",
    "REPOSITORY_WORKTREE",
  ]),
  targetAgentId: z.string().nullable().optional(),
  targetRepositoryIds: z.array(z.string().min(1)).nullable().optional(),
  /** @deprecated Use targetRepositoryIds. */
  targetRepositoryId: z.string().nullable().optional(),
  restartPolicy: z.enum(["NEVER", "ON_FAILURE", "ALWAYS"]).default("NEVER"),
  restartLimit: z.number().int().min(0).max(100).default(3),
  concurrency: z
    .enum(["EXCLUSIVE", "NON_EXCLUSIVE", "EXCLUDED"])
    .default("NON_EXCLUSIVE"),
  blocksGitOperations: z.boolean().default(false),
  quickActionEnabled: z.boolean().default(false),
  quickActionIconKey: z.string().default("terminal"),
  quickActionButtonVariant: z.string().default("default"),
  notificationsEnabled: z.boolean().default(true),
});

export function createCommandToolGroup(
  service: CommandsService,
): BuiltInToolGroup {
  return {
    id: "builtin:commands",
    name: "Commands",
    children: [],
    tools: [
      serviceTool({
        name: "get_commands",
        title: "Get commands",
        description: "List saved command definitions.",
        inputSchema: z.object({ includeArchived: z.boolean().default(false) }),
        service,
        method: "listDefinitions",
        arguments: ({ includeArchived }) => [includeArchived],
        resultKey: "commands",
      }),
      serviceTool({
        name: "get_command",
        title: "Get command",
        description: "Get one command definition.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "getDefinition",
        arguments: ({ id }) => [id],
        resultKey: "command",
      }),
      defineTool({
        name: "get_eligible_commands",
        title: "Get eligible commands",
        description: "List commands eligible for an agent or worktree target.",
        inputSchema: z.discriminatedUnion("targetType", [
          z.object({
            targetType: z.literal("AGENT"),
            agentId: z.string().min(1),
          }),
          z.object({
            targetType: z.literal("WORKTREE"),
            worktreeId: z.string().min(1),
          }),
        ]),
        outputSchema: z.object({ commands: z.unknown() }),
        handler: async (value) => ({
          commands: redactSensitiveToolOutput(
            await invokeService(
              service,
              value.targetType === "AGENT"
                ? "eligibleForAgent"
                : "eligibleForWorktree",
              [value.targetType === "AGENT" ? value.agentId : value.worktreeId],
            ),
          ),
        }),
      }),
      serviceTool({
        name: "get_command_runs",
        title: "Get command runs",
        description:
          "List command runs with target, archive, search, and cursor filters.",
        inputSchema: z.object({
          includeArchived: z.boolean().default(false),
          search: z.string().nullable().optional(),
          agentId: z.string().nullable().optional(),
          worktreeId: z.string().nullable().optional(),
          first: z.number().int().min(1).max(200).default(50),
          after: z.string().nullable().optional(),
        }),
        service,
        method: "listRuns",
        resultKey: "page",
      }),
      serviceTool({
        name: "get_command_run",
        title: "Get command run",
        description: "Get one command run and its attempts.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "getRun",
        arguments: ({ id }) => [id],
        resultKey: "run",
      }),
      serviceTool({
        name: "get_command_run_output",
        title: "Get command run output",
        description: "Read paginated terminal output chunks for a command run.",
        inputSchema: z.object({
          runId: z.string().min(1),
          afterAttempt: z.number().int().min(0).default(0),
          afterSequence: z.number().int().default(-1),
          first: z.number().int().min(1).max(5000).default(1000),
        }),
        service,
        method: "listOutput",
        arguments: (value) => [
          value.runId,
          value.afterAttempt,
          value.afterSequence,
          value.first,
        ],
        resultKey: "chunks",
      }),
      serviceTool({
        name: "start_command",
        title: "Start command",
        description: "Start a saved command on an eligible agent or worktree.",
        inputSchema: z.object({
          commandId: z.string().min(1),
          agentId: z.string().nullable().optional(),
          worktreeId: z.string().nullable().optional(),
          origin: z.string().default("MANUAL"),
          idempotencyKey: z.string().nullable().optional(),
        }),
        service,
        method: "startRun",
        resultKey: "run",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "start_custom_command",
        title: "Start custom command",
        description: "Start an ad hoc shell command on an agent or worktree.",
        inputSchema: z.object({
          script: z.string().min(1),
          agentId: z.string().nullable().optional(),
          worktreeId: z.string().nullable().optional(),
          origin: z.string().default("MANUAL"),
          idempotencyKey: z.string().nullable().optional(),
        }),
        service,
        method: "startCustomRun",
        resultKey: "run",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "terminate_command_run",
        title: "Terminate command run",
        description: "Request termination of an active command run.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "terminateRun",
        arguments: ({ id }) => [id],
        resultKey: "run",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "rerun_command",
        title: "Rerun command",
        description: "Create a new run from a previous command snapshot.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "rerun",
        arguments: ({ id }) => [id],
        resultKey: "run",
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "create_command",
        title: "Create command",
        description: "Create a saved command definition.",
        inputSchema: definitionInput,
        service,
        method: "createDefinition",
        resultKey: "command",
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "update_command",
        title: "Update command",
        description: "Replace a saved command definition.",
        inputSchema: z.object({
          id: z.string().min(1),
          input: definitionInput,
        }),
        service,
        method: "updateDefinition",
        arguments: ({ id, input }) => [id, input],
        resultKey: "command",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "archive_command",
        title: "Archive command",
        description: "Archive or restore a command definition.",
        inputSchema: z.object({
          id: z.string().min(1),
          archived: z.boolean().default(true),
        }),
        service,
        method: "archiveDefinition",
        arguments: ({ id, archived }) => [id, archived],
        resultKey: "command",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "archive_command_runs",
        title: "Archive command runs",
        description: "Archive or restore command runs.",
        inputSchema: z.object({
          ids: z.array(z.string().min(1)).min(1),
          archived: z.boolean().default(true),
        }),
        service,
        method: "archiveRuns",
        arguments: ({ ids, archived }) => [ids, archived],
        resultKey: "updated",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_command_runs",
        title: "Delete command runs",
        description: "Permanently delete command runs and stored output.",
        inputSchema: z.object({ ids: z.array(z.string().min(1)).min(1) }),
        service,
        method: "deleteRuns",
        arguments: ({ ids }) => [ids],
        resultKey: "count",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
    ],
  };
}
