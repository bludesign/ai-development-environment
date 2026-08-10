import * as z from "zod/v4";

import {
  WORKTREE_GIT_OPERATIONS,
  WORKTREE_OPERATIONS,
  WORKTREE_PREPARATION_ACTIONS,
} from "@ai-development-environment/agent-contract/worktrees";

import type { WorktreesService } from "@/services/worktrees";

import {
  DESTRUCTIVE_ANNOTATIONS,
  defineTool,
  WRITE_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { emptyInput, serviceTool } from "./service-tool";

const idInput = z.object({ id: z.string().min(1) });
const requestInput = z.object({
  worktreeId: z.string().min(1),
  requestId: z.string().min(1),
});
const selection = z.object({
  mode: z.enum(["NEW", "EXISTING", "TICKET"]),
  branchName: z.string().nullable().optional(),
  ticketKey: z.string().nullable().optional(),
  baseBranch: z.string().min(1),
});

const preparationActionInput = z.object({
  worktreeIds: z.array(z.string().min(1)).max(500),
  action: z.enum(WORKTREE_PREPARATION_ACTIONS),
  requestId: z.string().min(1),
});
const preparationMetadataSchema = z.object({
  id: z.string(),
  kind: z.enum(["WRITE", "DELETE", "ASSUME_UNCHANGED"]),
  path: z.string(),
  contentSha256: z.string().nullable(),
  byteCount: z.number().int().nonnegative().nullable(),
  definitionHash: z.string(),
});
const preparationOverviewSchema = z.object({
  repositories: z.array(
    z.object({
      repository: z.object({
        id: z.string(),
        name: z.string(),
        canonicalOrigin: z.string(),
        displayOrigin: z.string(),
      }),
      preparations: z.array(preparationMetadataSchema),
      worktrees: z.array(
        z.object({
          worktree: z.object({
            id: z.string(),
            codebaseId: z.string(),
            folder: z.string(),
            relativePath: z.string(),
            branch: z.string().nullable(),
            baseBranch: z.string().nullable(),
            primary: z.boolean(),
            availability: z.string(),
            missingAt: z.string().nullable(),
          }),
          agent: z.object({
            id: z.string(),
            name: z.string(),
            hostname: z.string(),
            version: z.string(),
          }),
          supported: z.boolean(),
          unsupportedReason: z.string().nullable(),
          overallState: z.string(),
          statuses: z.array(
            z.object({
              preparationId: z.string(),
              kind: z.enum(["WRITE", "DELETE", "ASSUME_UNCHANGED"]),
              path: z.string(),
              definitionHash: z.string(),
              state: z.string(),
              message: z.string().nullable(),
              checkedAt: z.string().nullable(),
            }),
          ),
          activeJob: z
            .object({ id: z.string(), status: z.string() })
            .nullable(),
        }),
      ),
    }),
  ),
});

export function createWorktreeToolGroup(
  service: WorktreesService,
): BuiltInToolGroup {
  return {
    id: "builtin:worktrees",
    name: "Worktrees",
    children: [],
    tools: [
      serviceTool({
        name: "get_worktrees",
        title: "Get worktrees",
        description:
          "Get the current worktree overview grouped by agent and codebase.",
        inputSchema: emptyInput,
        service,
        method: "overview",
        arguments: () => [],
        resultKey: "overview",
      }),
      defineTool({
        name: "get_worktree_preparation_overview",
        title: "Get worktree preparation overview",
        description:
          "Get persisted per-file preparation status for every repository worktree, including unsupported and offline worktrees.",
        inputSchema: emptyInput,
        outputSchema: z.object({ overview: preparationOverviewSchema }),
        handler: async () => {
          const overview = await service.preparationOverview();
          return {
            overview: {
              repositories: overview.repositories.map(
                ({ repository, worktrees }) => ({
                  repository: {
                    id: repository.id,
                    name: repository.name,
                    canonicalOrigin: repository.canonicalOrigin,
                    displayOrigin: repository.displayOrigin,
                  },
                  preparations: repository.preparations.map((preparation) => ({
                    id: preparation.id,
                    kind: preparation.kind as
                      "WRITE" | "DELETE" | "ASSUME_UNCHANGED",
                    path: preparation.path,
                    contentSha256: preparation.contentSha256,
                    byteCount: preparation.byteCount,
                    definitionHash: preparation.definitionHash,
                  })),
                  worktrees: worktrees.map((item) => ({
                    worktree: {
                      id: item.worktree.id,
                      codebaseId: item.worktree.codebaseId,
                      folder: item.worktree.folder,
                      relativePath: item.worktree.relativePath,
                      branch: item.worktree.branch,
                      baseBranch: item.worktree.baseBranch,
                      primary: item.worktree.primary,
                      availability: item.worktree.availability,
                      missingAt: item.worktree.missingAt?.toISOString() ?? null,
                    },
                    agent: {
                      id: item.agent.id,
                      name: item.agent.name,
                      hostname: item.agent.hostname,
                      version: item.agent.version,
                    },
                    supported: item.supported,
                    unsupportedReason: item.unsupportedReason,
                    overallState: item.overallState,
                    statuses: item.statuses.map((status) => ({
                      preparationId: status.preparation.id,
                      kind: status.preparation.kind as
                        "WRITE" | "DELETE" | "ASSUME_UNCHANGED",
                      path: status.preparation.path,
                      definitionHash: status.preparation.definitionHash,
                      state: status.state,
                      message: status.message,
                      checkedAt: status.checkedAt?.toISOString() ?? null,
                    })),
                    activeJob: item.activeJob
                      ? {
                          id: item.activeJob.id,
                          status: item.activeJob.status,
                        }
                      : null,
                  })),
                }),
              ),
            },
          };
        },
      }),
      defineTool({
        name: "run_worktree_preparations",
        title: "Run worktree preparations",
        description:
          "Inspect, apply, or undo repository preparations for up to 500 worktrees. Returns dispatched jobs and explicit skip reasons.",
        inputSchema: preparationActionInput,
        outputSchema: z.object({
          jobs: z.array(z.unknown()),
          skipped: z.array(
            z.object({ worktreeId: z.string(), reason: z.string() }),
          ),
        }),
        handler: (value) =>
          service.runPreparations(
            value.worktreeIds,
            value.action,
            value.requestId,
          ),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      defineTool({
        name: "get_worktree",
        title: "Get worktree",
        description: "Get one current worktree by ID.",
        inputSchema: idInput,
        outputSchema: z.object({ worktree: z.unknown().nullable() }),
        handler: async ({ id }) => {
          const overview = await service.overview();
          const worktree =
            overview.agents
              .flatMap((agent) => agent.codebases)
              .flatMap((codebase) => codebase.worktrees)
              .find((item) => item.id === id) ?? null;
          return { worktree };
        },
      }),
      serviceTool({
        name: "get_hidden_worktrees",
        title: "Get hidden worktrees",
        description: "List worktrees no longer present on their agents.",
        inputSchema: emptyInput,
        service,
        method: "hidden",
        arguments: () => [],
        resultKey: "worktrees",
      }),
      serviceTool({
        name: "inspect_worktree",
        title: "Inspect worktree",
        description: "Request a fresh inspection of a worktree.",
        inputSchema: requestInput,
        service,
        method: "inspect",
        arguments: (value) => [value.worktreeId, value.requestId],
        resultKey: "job",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "inspect_worktree_diff",
        title: "Inspect worktree diff",
        description: "Inspect a worktree diff for a scope, file, or commit.",
        inputSchema: requestInput.extend({
          scope: z.string().min(1),
          path: z.string().nullable().optional(),
          previousPath: z.string().nullable().optional(),
          commitSha: z.string().nullable().optional(),
        }),
        service,
        method: "inspectDiff",
        arguments: (value) => [
          value.worktreeId,
          {
            scope: value.scope,
            path: value.path,
            previousPath: value.previousPath,
            commitSha: value.commitSha,
          },
          value.requestId,
        ],
        resultKey: "inspection",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "refresh_worktrees",
        title: "Refresh worktrees",
        description: "Ask connected agents to refresh their worktree reports.",
        inputSchema: emptyInput,
        service,
        method: "requestRefresh",
        arguments: () => [],
        resultKey: "requested",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "refresh_worktree_pull_request",
        title: "Refresh worktree pull request",
        description: "Refresh the GitHub pull request attached to a worktree.",
        inputSchema: idInput,
        service,
        method: "refreshPullRequest",
        arguments: ({ id }) => [id],
        resultKey: "worktree",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "create_worktree",
        title: "Create worktree",
        description:
          "Create a worktree from a new, existing, or Jira ticket branch.",
        inputSchema: z.object({
          codebaseId: z.string().min(1),
          selection,
          requestId: z.string().min(1),
        }),
        service,
        method: "createWorktree",
        resultKey: "worktree",
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "change_worktree_branch",
        title: "Change worktree branch",
        description: "Switch a worktree to another branch selection.",
        inputSchema: z.object({
          worktreeId: z.string().min(1),
          selection,
          requestId: z.string().min(1),
          stashOnFailure: z.boolean().nullable().optional(),
        }),
        service,
        method: "changeWorktreeBranch",
        resultKey: "job",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "commit_worktree",
        title: "Commit worktree changes",
        description:
          "Stage all or an exact set of changed paths and create a Git commit in a worktree.",
        inputSchema: requestInput.extend({
          message: z.string().trim().min(1).max(50_000),
          signed: z.boolean().nullable().optional(),
          stageAll: z.boolean().default(true),
          paths: z.array(z.string().min(1)).max(500).default([]),
        }),
        service,
        method: "commitWorktree",
        resultKey: "job",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "move_worktree",
        title: "Move worktree",
        description:
          "Move work from one worktree into another codebase or worktree.",
        inputSchema: z.object({
          sourceWorktreeId: z.string().min(1),
          targetCodebaseId: z.string().min(1),
          targetWorktreeId: z.string().nullable().optional(),
          deleteSource: z.boolean().default(false),
          requestId: z.string().min(1),
        }),
        service,
        method: "moveWorktree",
        resultKey: "move",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "retry_worktree_move_with_stash",
        title: "Retry worktree move with stash",
        description: "Retry a blocked worktree move after stashing changes.",
        inputSchema: idInput,
        service,
        method: "retryWorktreeMoveWithStash",
        arguments: ({ id }) => [id],
        resultKey: "move",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "cancel_worktree_move",
        title: "Cancel worktree move",
        description: "Cancel an active worktree move.",
        inputSchema: idInput,
        service,
        method: "cancelWorktreeMove",
        arguments: ({ id }) => [id],
        resultKey: "move",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_worktree",
        title: "Delete worktree",
        description: "Delete a worktree and optionally its remote branch.",
        inputSchema: z.object({
          worktreeId: z.string().min(1),
          deleteRemoteBranch: z.boolean().default(false),
          requestId: z.string().min(1),
        }),
        service,
        method: "deleteWorktree",
        resultKey: "job",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "run_worktree_operation",
        title: "Run worktree operation",
        description: "Run a supported high-level operation in a worktree.",
        // Named rather than free text, so a caller can see which operations
        // exist instead of guessing and being turned away by the service.
        inputSchema: requestInput.extend({
          operation: z.enum(WORKTREE_OPERATIONS),
          forcePreparations: z.boolean().default(false),
        }),
        service,
        method: "runOperation",
        arguments: (value) => [
          value.worktreeId,
          value.operation,
          value.requestId,
          value.forcePreparations,
        ],
        resultKey: "job",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "run_worktree_git_operation",
        title: "Run worktree Git operation",
        description: "Run a supported Git operation in a worktree.",
        inputSchema: requestInput.extend({
          operation: z.enum(WORKTREE_GIT_OPERATIONS),
          branch: z.string().nullable().optional(),
          stashOid: z.string().nullable().optional(),
          stashChanges: z.boolean().nullable().optional(),
        }),
        service,
        method: "runGitOperation",
        resultKey: "job",
        annotations: WRITE_ANNOTATIONS,
      }),
      defineTool({
        name: "update_worktree_metadata",
        title: "Update worktree metadata",
        description: "Update a worktree base branch and/or highlight color.",
        inputSchema: z.object({
          id: z.string().min(1),
          baseBranch: z.string().nullable().optional(),
          highlightColor: z.string().nullable().optional(),
        }),
        outputSchema: z.object({ worktree: z.unknown() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ id, baseBranch, highlightColor }) => {
          let worktree: unknown = null;
          if (baseBranch !== undefined)
            worktree = await service.updateBaseBranch(id, baseBranch);
          if (highlightColor !== undefined)
            worktree = await service.updateHighlight(id, highlightColor);
          if (baseBranch === undefined && highlightColor === undefined)
            throw new Error("At least one metadata field is required");
          return { worktree };
        },
      }),
      serviceTool({
        name: "set_worktree_tags",
        title: "Set worktree tags",
        description: "Replace the tags assigned to a worktree.",
        inputSchema: z.object({
          id: z.string().min(1),
          tagIds: z.array(z.string().min(1)),
        }),
        service,
        method: "setTags",
        arguments: (value) => [value.id, value.tagIds],
        resultKey: "worktree",
        annotations: WRITE_ANNOTATIONS,
      }),
    ],
  };
}
