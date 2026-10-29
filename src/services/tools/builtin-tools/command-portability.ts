import * as z from "zod/v4";
import type { CommandsService } from "@/services/commands";
import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
} from "../builtin-tools";
import { redactSensitiveToolOutput } from "./service-tool";

const Id = z.string().trim().min(1).max(256);
const Target = z.enum([
  "ANY_AGENT_HOME",
  "SPECIFIC_AGENT_HOME",
  "ANY_WORKTREE",
  "REPOSITORY_WORKTREE",
]);
const Portable = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  script: z.string().min(1).max(1000000),
  targetKind: Target.optional(),
  targetAgentName: z.string().max(200).nullable().optional(),
  targetAgentId: Id.nullable().optional(),
  targetRepositories: z
    .array(
      z.object({
        canonicalOrigin: z.string().min(1).max(4096),
        name: z.string().max(200),
      }),
    )
    .max(500)
    .optional(),
  targetRepositoryIds: z.array(Id).max(500).optional(),
  targetRepositoryId: Id.nullable().optional(),
  restartPolicy: z.enum(["NEVER", "ON_FAILURE", "ALWAYS"]).optional(),
  restartLimit: z.number().int().min(0).max(100).nullable().optional(),
  concurrency: z.enum(["EXCLUSIVE", "NON_EXCLUSIVE", "EXCLUDED"]).optional(),
  blocksGitOperations: z.boolean().optional(),
  quickActionEnabled: z.boolean().optional(),
  quickActionIconKey: z.string().max(100).optional(),
  quickActionButtonVariant: z.string().max(100).optional(),
  notificationsEnabled: z.boolean().optional(),
});
const Export = z.object({
  format: z.literal("aide.command.export"),
  schemaVersion: z.number().int().min(1).max(2),
  exportedAt: z.string().optional(),
  command: Portable,
});
const Command = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  script: z.string(),
  targetKind: Target,
  targetAgentId: z.string().nullable(),
  targetRepositoryIds: z.array(z.string()),
  restartPolicy: z.string(),
  restartLimit: z.number().int().nullable(),
  concurrency: z.string(),
  blocksGitOperations: z.boolean(),
  quickActionEnabled: z.boolean(),
  quickActionIconKey: z.string(),
  quickActionButtonVariant: z.string(),
  notificationsEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export function createCommandPortabilityTools(service: CommandsService) {
  return [
    defineTool({
      name: "export_command",
      title: "Export command",
      description:
        "Export a saved shell command with portable target identities. Authored script contents are included.",
      inputSchema: z.object({ id: Id }),
      outputSchema: z.object({ payload: Export }),
      handler: async ({ id }) => ({
        payload: await service.exportDefinition(id),
      }),
    }),
    defineTool({
      name: "import_command",
      title: "Import command",
      description:
        "Import a portable command or bare definition. Missing scoped targets may widen eligibility; the service disables its quick action when that occurs.",
      inputSchema: z.object({
        payload: z.union([z.string().max(2 * 1024 * 1024), Export, Portable]),
        name: z.string().trim().min(1).max(120).nullable().optional(),
      }),
      outputSchema: z.object({ command: Command }),
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      handler: async (input) => ({
        command: redactSensitiveToolOutput(
          await service.importDefinition(input),
        ),
      }),
    }),
    defineTool({
      name: "delete_command",
      title: "Delete command",
      description:
        "Permanently delete a command definition that has no run history. Commands with history must be archived.",
      inputSchema: z.object({ id: Id }),
      outputSchema: z.object({ deleted: z.boolean() }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
      handler: async ({ id }) => ({
        deleted: await service.deleteDefinition(id),
      }),
    }),
  ];
}
