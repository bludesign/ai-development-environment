import * as z from "zod/v4";
import type { RunsService } from "@/services/runs";
import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
} from "../builtin-tools";
import { redactSensitiveToolOutput } from "./service-tool";

const Id = z.string().trim().min(1).max(256);
const Draft = z.object({
  id: z.string(),
  kind: z.string(),
  worktreeId: z.string().nullable(),
  agentId: z.string().nullable(),
  jiraIssueKey: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  webSearchEnabled: z.boolean(),
  mcpPresetIds: z.array(z.string()),
  prompt: z.string(),
  attachments: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      contentType: z.string(),
      size: z.number().int(),
      sha256: z.string(),
      createdAt: z.string(),
    }),
  ),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
function draftView(
  value: NonNullable<Awaited<ReturnType<RunsService["draft"]>>>,
) {
  let presets: unknown = [];
  try {
    presets = JSON.parse(value.mcpPresetIdsJson);
  } catch {
    /* Legacy rows have no preset selection. */
  }
  return Draft.parse({
    ...(redactSensitiveToolOutput(value) as object),
    mcpPresetIds: Array.isArray(presets)
      ? presets.filter((id): id is string => typeof id === "string")
      : [],
  });
}
const DraftInput = z.object({
  id: Id.nullable().optional(),
  kind: z.enum(["PLAN", "SESSION"]),
  worktreeId: Id,
  jiraIssueKey: z.string().max(100).nullable().optional(),
  provider: z.enum(["CODEX", "CLAUDE", "OPENCODE"]),
  model: z.string().trim().min(1).max(200),
  effort: z.string().max(100).nullable().optional(),
  webSearchEnabled: z.boolean().default(true),
  prompt: z.string().trim().min(1).max(200000),
  attachmentIds: z.array(Id).max(100).default([]),
  mcpPresetIds: z.array(Id).max(100).default([]),
});
const ImportStatus = z.object({
  id: z.string(),
  agentId: z.string(),
  provider: z.string(),
  status: z.string(),
  lastStartedAt: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  importedCount: z.number().int(),
  unmatchedCount: z.number().int(),
  updatedAt: z.string(),
});

export function createRunManagementTools(service: RunsService) {
  return [
    defineTool({
      name: "get_run_drafts",
      title: "Get run drafts",
      description:
        "List saved run drafts and attachment metadata with pagination. Native session data and attachment storage paths are excluded.",
      inputSchema: z.object({
        search: z.string().max(200).nullable().optional(),
        archive: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
        first: z.number().int().min(1).max(200).default(100),
        after: Id.nullable().optional(),
      }),
      outputSchema: z.object({
        page: z.object({
          items: z.array(Draft),
          nextCursor: z.string().nullable(),
          totalCount: z.number().int(),
        }),
      }),
      handler: async (input) => {
        const page = await service.drafts(input);
        return { page: { ...page, items: page.items.map(draftView) } };
      },
    }),
    defineTool({
      name: "get_run_draft",
      title: "Get run draft",
      description:
        "Read a saved draft with safe attachment metadata and its selected MCP preset IDs.",
      inputSchema: z.object({ id: Id }),
      outputSchema: z.object({ draft: Draft.nullable() }),
      handler: async ({ id }) => {
        const draft = await service.draft(id);
        return { draft: draft ? draftView(draft) : null };
      },
    }),
    defineTool({
      name: "save_run_draft",
      title: "Save run draft",
      description:
        "Create or replace a saved run draft. Supply id to update; omitting id creates a new draft.",
      inputSchema: z.object({ input: DraftInput }),
      outputSchema: z.object({ draft: Draft }),
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      handler: async ({ input }) => {
        const draft = await service.saveDraft(input);
        if (!draft) throw new Error("Saved draft not found");
        return { draft: draftView(draft) };
      },
    }),
    defineTool({
      name: "archive_run_drafts",
      title: "Archive run drafts",
      description: "Archive or restore selected run drafts.",
      inputSchema: z.object({
        ids: z.array(Id).min(1).max(500),
        archived: z.boolean(),
      }),
      outputSchema: z.object({ count: z.number().int() }),
      annotations: WRITE_ANNOTATIONS,
      handler: async ({ ids, archived }) => ({
        count: await service.archiveDrafts(ids, archived),
      }),
    }),
    defineTool({
      name: "delete_run_drafts",
      title: "Delete run drafts",
      description:
        "Permanently delete selected run drafts and their retained attachment files.",
      inputSchema: z.object({ ids: z.array(Id).min(1).max(500) }),
      outputSchema: z.object({ count: z.number().int() }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
      handler: async ({ ids }) => ({ count: await service.deleteDrafts(ids) }),
    }),
    defineTool({
      name: "get_run_provider_import_status",
      title: "Get run provider import status",
      description:
        "Read agent provider-import progress and error counts without native catalogs, cursors or transcripts. Import ingestion remains agent-only.",
      inputSchema: z.object({}),
      outputSchema: z.object({ statuses: z.array(ImportStatus) }),
      handler: async () => ({
        statuses: redactSensitiveToolOutput(
          await service.providerImportStatus(),
        ),
      }),
    }),
    defineTool({
      name: "cancel_run_question",
      title: "Cancel run question",
      description:
        "Cancel a pending native form and let its managed OpenCode run continue. Does not cancel the run.",
      inputSchema: z.object({ batchId: Id }),
      outputSchema: z.object({
        run: z
          .object({ id: z.string(), status: z.string(), phase: z.string() })
          .nullable(),
      }),
      annotations: WRITE_ANNOTATIONS,
      handler: async ({ batchId }) => ({
        run: await service.cancelQuestion(batchId),
      }),
    }),
  ];
}
