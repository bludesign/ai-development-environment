import type {
  CodebaseWorktreeReport,
  WorktreeActivityReport,
  WorktreeEditorVariant,
  WorktreeOperation,
} from "@ai-development-environment/agent-contract/worktrees";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  WorktreeBranchSelection,
  WorktreesService,
} from "@/services/worktrees";

function requireAgent(context: GraphQLContext): string {
  if (!context.agentId) throw new Error("Agent authentication is required");
  return context.agentId;
}

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export const createWorktreeResolvers = (service: WorktreesService) => ({
  WorktreeLatestBuild: {
    destination: (value: { destinationJson: string }) =>
      JSON.parse(value.destinationJson) as unknown,
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  Worktree: {
    lastCheckedAt: (value: { lastCheckedAt: Date | null }) =>
      iso(value.lastCheckedAt),
    missingAt: (value: { missingAt: Date | null }) => iso(value.missingAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  WorktreeTag: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  WorktreeSettings: {
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  WorktreeMove: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
  },
  Query: {
    worktreeOverview: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.overview();
    },
    hiddenWorktrees: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.hidden();
    },
    worktreeSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.settings();
    },
    previewWorktreeTicketBranch: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          codebaseId: string;
          worktreeId?: string | null;
          ticketKey: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.previewTicketBranch(input);
    },
    worktreeMove: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getMove(id);
    },
  },
  Mutation: {
    refreshWorktrees: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.requestRefresh();
    },
    reportWorktrees: (
      _root: unknown,
      { reports }: { reports: CodebaseWorktreeReport[] },
      context: GraphQLContext,
    ) => service.report(requireAgent(context), reports),
    reportWorktreeActivity: (
      _root: unknown,
      { input }: { input: WorktreeActivityReport },
      context: GraphQLContext,
    ) => service.reportActivity(requireAgent(context), input),
    inspectWorktree: (
      _root: unknown,
      { id, requestId }: { id: string; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.inspect(id, requestId);
    },
    runWorktreeOperation: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          worktreeId: string;
          operation: WorktreeOperation;
          requestId: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.runOperation(
        input.worktreeId,
        input.operation,
        input.requestId,
      );
    },
    createWorktree: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          codebaseId: string;
          selection: WorktreeBranchSelection;
          requestId: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createWorktree(input);
    },
    changeWorktreeBranch: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          worktreeId: string;
          selection: WorktreeBranchSelection;
          requestId: string;
          stashOnFailure?: boolean | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.changeWorktreeBranch(input);
    },
    moveWorktree: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          sourceWorktreeId: string;
          targetCodebaseId: string;
          targetWorktreeId?: string | null;
          deleteSource: boolean;
          requestId: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.moveWorktree(input);
    },
    retryWorktreeMoveWithStash: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.retryWorktreeMoveWithStash(id);
    },
    cancelWorktreeMove: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.cancelWorktreeMove(id);
    },
    deleteWorktree: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          worktreeId: string;
          deleteRemoteBranch: boolean;
          requestId: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteWorktree(input);
    },
    updateWorktreeBaseBranch: (
      _root: unknown,
      { id, baseBranch }: { id: string; baseBranch?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateBaseBranch(id, baseBranch ?? null);
    },
    updateWorktreeHighlight: (
      _root: unknown,
      { id, color }: { id: string; color?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateHighlight(id, color ?? null);
    },
    setWorktreeTags: (
      _root: unknown,
      { id, tagIds }: { id: string; tagIds: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.setTags(id, tagIds);
    },
    saveWorktreeTag: (
      _root: unknown,
      { input }: { input: { id?: string | null; name: string; color: string } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveTag(input);
    },
    deleteWorktreeTag: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteTag(id);
    },
    saveWorktreeSettings: (
      _root: unknown,
      { editorVariant }: { editorVariant: WorktreeEditorVariant },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSettings(editorVariant);
    },
    purgeHiddenWorktree: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.purge(id);
    },
    purgeAllHiddenWorktrees: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.purgeAll();
    },
  },
  Subscription: {
    worktreeOverviewChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
    },
    worktreeInspectionChanged: {
      subscribe: (
        _root: unknown,
        { worktreeId }: { worktreeId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeInspection(worktreeId);
      },
    },
  },
});
