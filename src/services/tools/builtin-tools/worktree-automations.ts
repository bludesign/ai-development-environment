import * as z from "zod/v4";

import type { WorktreeAutomationService } from "@/services/worktrees";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";

const AutoSyncSchema = z.object({
  worktreeId: z.string(),
  state: z.string(),
  conflictWorkflowId: z.string().nullable(),
  conflictWorkflowChoice: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  updatedAt: z.string(),
});

const AutoMergeSchema = z.object({
  worktreeId: z.string(),
  state: z.string(),
  repositoryNameWithOwner: z.string(),
  pullRequestNumber: z.number().int(),
  mergeMethod: z.enum(["MERGE", "REBASE", "SQUASH"]),
  commitHeadline: z.string(),
  commitBody: z.string(),
  authorEmail: z.string().nullable(),
  deleteWorktree: z.boolean(),
  moveTicketToDone: z.boolean(),
  ticketKey: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});

type Service = () => WorktreeAutomationService;

export function createWorktreeAutomationToolGroup(
  service: Service,
): BuiltInToolGroup {
  return {
    id: "builtin:worktree-automations",
    name: "Worktree Automations",
    children: [],
    tools: [
      defineTool({
        name: "get_worktree_automations",
        title: "Get worktree automations",
        description:
          "Inspect the persisted Auto Sync and Auto Merge configuration and state for a worktree.",
        inputSchema: z.object({ worktreeId: z.string().min(1) }),
        outputSchema: z.object({
          autoSync: AutoSyncSchema.nullable(),
          autoMerge: AutoMergeSchema.nullable(),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ worktreeId }) => ({
          autoSync: await service().autoSync(worktreeId),
          autoMerge: await service().autoMerge(worktreeId),
        }),
      }),
      defineTool({
        name: "configure_worktree_auto_sync",
        title: "Configure worktree Auto Sync",
        description:
          "Enable or update Auto Sync. Optionally select a merge-conflict quick-action workflow and one of its trigger choices.",
        inputSchema: z.object({
          worktreeId: z.string().min(1),
          conflictWorkflowId: z.string().min(1).nullable().optional(),
          conflictWorkflowChoice: z.string().min(1).nullable().optional(),
        }),
        outputSchema: z.object({ autoSync: AutoSyncSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          autoSync: await service().configureAutoSync(input),
        }),
      }),
      defineTool({
        name: "retry_worktree_auto_sync",
        title: "Retry worktree Auto Sync",
        description: "Resume a paused Auto Sync rule.",
        inputSchema: z.object({ worktreeId: z.string().min(1) }),
        outputSchema: z.object({ autoSync: AutoSyncSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ worktreeId }) => ({
          autoSync: await service().retryAutoSync(worktreeId),
        }),
      }),
      defineTool({
        name: "cancel_worktree_auto_sync",
        title: "Cancel worktree Auto Sync",
        description: "Cancel any active job and remove the Auto Sync rule.",
        inputSchema: z.object({ worktreeId: z.string().min(1) }),
        outputSchema: z.object({ cancelled: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ worktreeId }) => ({
          cancelled: await service().cancelAutoSync(worktreeId),
        }),
      }),
      defineTool({
        name: "configure_worktree_auto_merge",
        title: "Configure worktree Auto Merge",
        description:
          "Enable or update GitHub-native Auto Merge and its optional Jira/worktree post-merge actions.",
        inputSchema: z.object({
          worktreeId: z.string().min(1),
          repositoryNameWithOwner: z.string().min(3),
          pullRequestNumber: z.number().int().positive(),
          method: z.enum(["MERGE", "REBASE", "SQUASH"]),
          commitHeadline: z.string().min(1),
          commitBody: z.string(),
          authorEmail: z.string().email().nullable().optional(),
          deleteWorktree: z.boolean(),
          moveTicketToDone: z.boolean(),
        }),
        outputSchema: z.object({ autoMerge: AutoMergeSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          autoMerge: await service().configureAutoMerge(input),
        }),
      }),
      defineTool({
        name: "retry_worktree_auto_merge",
        title: "Retry worktree Auto Merge",
        description:
          "Retry an Auto Merge rule that needs attention, including its safe post-merge actions.",
        inputSchema: z.object({ worktreeId: z.string().min(1) }),
        outputSchema: z.object({ autoMerge: AutoMergeSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ worktreeId }) => ({
          autoMerge: await service().retryAutoMerge(worktreeId),
        }),
      }),
      defineTool({
        name: "cancel_worktree_auto_merge",
        title: "Cancel worktree Auto Merge",
        description:
          "Disable GitHub-native Auto Merge when still active and remove the persisted rule.",
        inputSchema: z.object({ worktreeId: z.string().min(1) }),
        outputSchema: z.object({ cancelled: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ worktreeId }) => ({
          cancelled: await service().cancelAutoMerge(worktreeId),
        }),
      }),
    ],
  };
}
