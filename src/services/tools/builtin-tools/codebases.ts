import * as z from "zod/v4";

import {
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
} from "@ai-development-environment/agent-contract/codebases";

import type {
  CodebasesService,
  CodebaseToolsService,
} from "@/services/codebases";
import {
  GetCodebaseInputSchema,
  GetCodebaseOutputSchema,
  GetCodebaseRepositoriesOutputSchema,
  GetCodebaseRepositoryInputSchema,
  GetCodebaseRepositoryOutputSchema,
  GetCodebasesInputSchema,
  GetCodebasesOutputSchema,
  SearchCodebasesInputSchema,
  SearchCodebasesOutputSchema,
} from "@/services/codebases";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolDefinition,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { agentJobView, jsonSafe } from "../builtin-views";
import { serviceTool } from "./service-tool";

const EmptyInputSchema = z.object({});
const CodebaseSettingsOutputSchema = z.object({
  settings: z.object({
    refreshIntervalSeconds: z.number().int(),
    fetchIntervalSeconds: z.number().int(),
    defaultJiraBranchRegex: z.string(),
    updatedAt: z.string(),
  }),
});
const BrowseAgentDirectoryInputSchema = z.object({
  agentId: z.string().min(1),
  path: z.string().nullable().default(null),
  requestId: z.string().min(1),
});
const BrowseAgentDirectoryOutputSchema = z.object({ listing: z.unknown() });
const InspectAgentCodebaseInputSchema = z.object({
  agentId: z.string().min(1),
  folder: z.string().min(1),
  requestId: z.string().min(1),
});
const InspectAgentCodebaseOutputSchema = z.object({ inspection: z.unknown() });
const CodebaseBatchInputSchema = z.object({
  codebaseIds: z.array(z.string().min(1)).min(1).max(500),
  requestId: z.string().min(1),
});
const CodebaseBatchOutputSchema = z.object({
  jobs: z.array(z.unknown()),
  skipped: z.array(z.object({ codebaseId: z.string(), reason: z.string() })),
});
const InspectGitStateInputSchema = z.object({
  codebaseId: z.string().min(1),
  requestId: z.string().min(1),
});
const InspectGitStateOutputSchema = z.object({ state: z.unknown() });
const InspectStashInputSchema = z.object({
  codebaseId: z.string().min(1),
  stashOid: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i),
  requestId: z.string().min(1),
});
const InspectStashOutputSchema = z.object({ diff: z.unknown() });
const RepositoryPreparationSchema = z.object({
  id: z.string(),
  kind: z.enum(["WRITE", "DELETE", "ASSUME_UNCHANGED"]),
  path: z.string(),
  contentBase64: z.string().nullable(),
  contentSha256: z.string().nullable(),
  byteCount: z.number().int().nonnegative().nullable(),
  definitionHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const RepositoryPreparationsInputSchema = z.object({
  repositoryId: z.string().min(1),
});

const preparationView = (preparation: {
  id: string;
  kind: string;
  path: string;
  contents: Uint8Array | null;
  contentSha256: string | null;
  byteCount: number | null;
  definitionHash: string;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: preparation.id,
  kind: preparation.kind as "WRITE" | "DELETE" | "ASSUME_UNCHANGED",
  path: preparation.path,
  contentBase64: preparation.contents
    ? Buffer.from(preparation.contents).toString("base64")
    : null,
  contentSha256: preparation.contentSha256,
  byteCount: preparation.byteCount,
  definitionHash: preparation.definitionHash,
  createdAt: preparation.createdAt.toISOString(),
  updatedAt: preparation.updatedAt.toISOString(),
});

export function createCodebaseToolGroup(
  codebaseTools: CodebaseToolsService,
  codebases?: CodebasesService,
): BuiltInToolGroup {
  const tools: BuiltInToolDefinition[] = [
    defineTool({
      name: "get_codebases",
      title: "Get codebases",
      description: "List every registered codebase checkout.",
      inputSchema: GetCodebasesInputSchema,
      outputSchema: GetCodebasesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async () => ({ codebases: await codebaseTools.list() }),
    }),
    defineTool({
      name: "get_codebase",
      title: "Get codebase",
      description: "Get one registered codebase by ID or exact folder path.",
      inputSchema: GetCodebaseInputSchema,
      outputSchema: GetCodebaseOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (input) => ({
        codebase:
          "id" in input
            ? await codebaseTools.getById(input.id)
            : input.agentId
              ? await codebaseTools.getByPath(input.path, input.agentId)
              : await codebaseTools.getByPath(input.path),
      }),
    }),
  ];

  if (codebases) {
    tools.splice(
      1,
      0,
      defineTool({
        name: "search_codebases",
        title: "Search codebases",
        description:
          "Search registered codebases by text, agent, repository, branch, availability, or sync state.",
        inputSchema: SearchCodebasesInputSchema,
        outputSchema: SearchCodebasesOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: (input) => codebaseTools.search(input),
      }),
      serviceTool({
        name: "register_codebase",
        title: "Register codebase",
        description: "Register a previously inspected agent repository folder.",
        inputSchema: z.object({
          inspectionJobId: z.string().min(1),
          name: z.string().nullable().optional(),
          description: z.string().nullable().optional(),
        }),
        service: codebases,
        method: "confirm",
        resultKey: "codebase",
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "update_codebase_repository",
        title: "Update codebase repository",
        description:
          "Update canonical repository metadata and linked skill groups.",
        inputSchema: z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          description: z.string(),
          jiraBranchRegex: z.string().nullable().optional(),
          keepBaseBranchUpToDate: z.boolean(),
          skillGroupIds: z.array(z.string()).nullable().optional(),
        }),
        service: codebases,
        method: "updateRepository",
        arguments: (value) => [
          value.id,
          value.name,
          value.description,
          value.jiraBranchRegex,
          value.keepBaseBranchUpToDate,
          value.skillGroupIds,
        ],
        resultKey: "repository",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_codebase_settings",
        title: "Update codebase settings",
        description:
          "Update global refresh, fetch, and Jira branch parsing settings.",
        inputSchema: z.object({
          refreshIntervalSeconds: z.number().int().positive(),
          fetchIntervalSeconds: z.number().int().positive(),
          defaultJiraBranchRegex: z.string(),
        }),
        service: codebases,
        method: "updateSettings",
        resultKey: "settings",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "remove_codebase",
        title: "Remove codebase",
        description:
          "Remove a registered codebase from the control plane without deleting its repository folder.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service: codebases,
        method: "removeCodebase",
        arguments: ({ id }) => [id],
        resultKey: "removed",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "run_codebase_git_operation",
        title: "Run codebase Git operation",
        description:
          "Run a supported Git operation against a registered codebase.",
        inputSchema: z.object({
          codebaseId: z.string().min(1),
          operation: z.string().min(1),
          branch: z.string().nullable().optional(),
          stashOid: z.string().nullable().optional(),
          stashChanges: z.boolean().nullable().optional(),
          requestId: z.string().min(1),
        }),
        service: codebases,
        method: "runGitOperation",
        resultKey: "job",
        annotations: WRITE_ANNOTATIONS,
      }),
    );
    tools.push(
      defineTool({
        name: "get_codebase_repositories",
        title: "Get codebase repositories",
        description: "List canonical repositories and their checkout counts.",
        inputSchema: EmptyInputSchema,
        outputSchema: GetCodebaseRepositoriesOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({
          repositories: await codebaseTools.repositories(),
        }),
      }),
      defineTool({
        name: "get_codebase_repository",
        title: "Get codebase repository",
        description:
          "Get a canonical repository and all of its registered checkouts.",
        inputSchema: GetCodebaseRepositoryInputSchema,
        outputSchema: GetCodebaseRepositoryOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ id }) => ({
          repository: await codebaseTools.repository(id),
        }),
      }),
      defineTool({
        name: "get_codebase_repository_preparations",
        title: "Get repository preparations",
        description:
          "Get every write, delete, and assume-unchanged rule configured for a repository, including uploaded write contents.",
        inputSchema: RepositoryPreparationsInputSchema,
        outputSchema: z.object({
          preparations: z.array(RepositoryPreparationSchema),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ repositoryId }) => ({
          preparations: (
            await codebases.repositoryPreparations(repositoryId)
          ).map(preparationView),
        }),
      }),
      defineTool({
        name: "save_codebase_repository_preparations",
        title: "Save repository preparations",
        description:
          "Atomically replace a repository's preparation rules. Existing write contents are retained when their rule ID is supplied without contentBase64; omitted rules are deleted.",
        inputSchema: RepositoryPreparationsInputSchema.extend({
          preparations: z
            .array(
              z.object({
                id: z.string().min(1).nullable().optional(),
                kind: z.enum(["WRITE", "DELETE", "ASSUME_UNCHANGED"]),
                path: z.string().min(1),
                contentBase64: z.string().nullable().optional(),
              }),
            )
            .max(500),
        }),
        outputSchema: z.object({
          preparations: z.array(RepositoryPreparationSchema),
        }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ repositoryId, preparations }) => {
          await codebases.saveRepositoryPreparations(
            repositoryId,
            preparations,
          );
          return {
            preparations: (
              await codebases.repositoryPreparations(repositoryId)
            ).map(preparationView),
          };
        },
      }),
      defineTool({
        name: "get_codebase_settings",
        title: "Get codebase settings",
        description: "Get global codebase refresh, fetch, and branch settings.",
        inputSchema: EmptyInputSchema,
        outputSchema: CodebaseSettingsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => {
          const settings = await codebases.settings();
          return {
            settings: {
              refreshIntervalSeconds: settings.refreshIntervalSeconds,
              fetchIntervalSeconds: settings.fetchIntervalSeconds,
              defaultJiraBranchRegex: settings.defaultJiraBranchRegex,
              updatedAt: settings.updatedAt.toISOString(),
            },
          };
        },
      }),
      defineTool({
        name: "browse_agent_directory",
        title: "Browse agent directory",
        description: "List candidate repository folders on an enrolled agent.",
        inputSchema: BrowseAgentDirectoryInputSchema,
        outputSchema: BrowseAgentDirectoryOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ agentId, path, requestId }) => ({
          listing: await codebases.browse(agentId, path, requestId),
        }),
      }),
      defineTool({
        name: "inspect_agent_codebase",
        title: "Inspect agent codebase",
        description:
          "Inspect a repository folder without registering or changing it.",
        inputSchema: InspectAgentCodebaseInputSchema,
        outputSchema: InspectAgentCodebaseOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ agentId, folder, requestId }) => ({
          inspection: jsonSafe(
            await codebases.inspect(agentId, folder, requestId),
          ),
        }),
      }),
      defineTool({
        name: "refresh_codebases",
        title: "Refresh codebases",
        description: "Queue local metadata refreshes for registered codebases.",
        inputSchema: CodebaseBatchInputSchema,
        outputSchema: CodebaseBatchOutputSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ codebaseIds, requestId }) => {
          const result = await codebases.runOperation(
            CODEBASE_REFRESH_JOB_KIND,
            codebaseIds,
            requestId,
          );
          return {
            jobs: result.jobs.map((job) =>
              agentJobView(job as unknown as Record<string, unknown>),
            ),
            skipped: result.skipped,
          };
        },
      }),
      defineTool({
        name: "fetch_codebases",
        title: "Fetch codebases",
        description:
          "Queue remote Git fetches and configured base-branch updates.",
        inputSchema: CodebaseBatchInputSchema,
        outputSchema: CodebaseBatchOutputSchema,
        annotations: { ...WRITE_ANNOTATIONS, openWorldHint: true },
        handler: async ({ codebaseIds, requestId }) => {
          const result = await codebases.runOperation(
            CODEBASE_FETCH_JOB_KIND,
            codebaseIds,
            requestId,
          );
          return {
            jobs: result.jobs.map((job) =>
              agentJobView(job as unknown as Record<string, unknown>),
            ),
            skipped: result.skipped,
          };
        },
      }),
      defineTool({
        name: "inspect_codebase_git_state",
        title: "Inspect codebase Git state",
        description: "Inspect branches, checkout locations, and stashes.",
        inputSchema: InspectGitStateInputSchema,
        outputSchema: InspectGitStateOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ codebaseId, requestId }) => ({
          state: await codebases.inspectGitState(codebaseId, requestId),
        }),
      }),
      defineTool({
        name: "inspect_codebase_stash",
        title: "Inspect codebase stash",
        description: "Read a bounded textual patch for a Git stash.",
        inputSchema: InspectStashInputSchema,
        outputSchema: InspectStashOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ codebaseId, stashOid, requestId }) => ({
          diff: await codebases.inspectStash(codebaseId, stashOid, requestId),
        }),
      }),
    );
  }

  return {
    id: "builtin:codebases",
    name: "Codebases",
    tools,
    children: [],
  };
}
