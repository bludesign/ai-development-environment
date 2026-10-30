import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ReviewersService } from "@/services/reviewers/service";
import type { SaveReviewerPoolsInput } from "@/services/reviewers/types";

function control(context: GraphQLContext) {
  if (context.agentId)
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
}

export function canAssignReviewers(value: {
  codebase?: { repository?: { hasConfiguredCodeReviewers?: boolean } };
  pullRequest?: { state: string } | null;
  gitLabMergeRequest?: { state: string } | null;
}) {
  const state = (
    value.gitLabMergeRequest ?? value.pullRequest
  )?.state.toUpperCase();
  return (
    value.codebase?.repository?.hasConfiguredCodeReviewers === true &&
    (state === "OPEN" || state === "OPENED")
  );
}

export const createReviewerResolvers = (service: ReviewersService) => ({
  CodebaseRepository: {
    hasConfiguredCodeReviewers: (value: {
      hasConfiguredCodeReviewers?: boolean;
    }) => value.hasConfiguredCodeReviewers === true,
  },
  Worktree: { canAssignReviewers },
  Query: {
    worktreeReviewStatus: (
      _: unknown,
      args: { worktreeId: string },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.worktreeReviewStatus(args.worktreeId);
    },
    repositoryCodeReviewers: (
      _: unknown,
      args: {
        repositoryId: string;
        ref?: string | null;
        refresh?: boolean | null;
      },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.repositoryCodeReviewers(
        args.repositoryId,
        args.ref,
        args.refresh ?? false,
      );
    },
    worktreeReviewerAssignment: (
      _: unknown,
      args: { worktreeId: string },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.worktreeReviewerAssignment(args.worktreeId);
    },
    previewRandomWorktreeReviewers: (
      _: unknown,
      args: {
        worktreeId: string;
        requestId: string;
        selectedReviewerIds?: string[] | null;
      },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.previewRandomWorktreeReviewers(
        args.worktreeId,
        args.requestId,
        args.selectedReviewerIds,
      );
    },
  },
  Mutation: {
    saveRepositoryCodeReviewers: (
      _: unknown,
      args: { input: SaveReviewerPoolsInput },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.saveRepositoryCodeReviewers(args.input);
    },
    assignWorktreeReviewers: (
      _: unknown,
      args: {
        input: { worktreeId: string; requestId: string; reviewerIds: string[] };
      },
      context: GraphQLContext,
    ) => {
      control(context);
      return service.assignWorktreeReviewers(args.input);
    },
  },
});
