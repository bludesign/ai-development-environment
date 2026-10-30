import { posix, win32 } from "node:path";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ActionCenterService } from "@/services/action-center";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createActionCenterResolvers = (service: ActionCenterService) => ({
  ActionCenterWorktree: {
    relativePath: (worktree: {
      folder: string;
      codebase?: { agent: { baseRepoDirectory: string | null } };
    }) => {
      const path = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(worktree.folder)
        ? win32
        : posix;
      const baseDirectory = worktree.codebase?.agent.baseRepoDirectory;
      const relativePath = baseDirectory
        ? path.relative(baseDirectory, worktree.folder)
        : path.basename(worktree.folder);
      return path.isAbsolute(relativePath)
        ? path.basename(worktree.folder)
        : relativePath || ".";
    },
  },
  Query: {
    actionCenterSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.settings();
    },
    actionCenter: (
      _root: unknown,
      args: Parameters<ActionCenterService["list"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.list(args);
    },
  },
  Mutation: {
    saveActionCenterSettings: (
      _root: unknown,
      { input }: { input: Parameters<ActionCenterService["saveSettings"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSettings(input);
    },
    refreshActionCenter: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.refresh();
    },
    acknowledgeActionCenterItem: (
      _root: unknown,
      { input }: { input: Parameters<ActionCenterService["acknowledge"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.acknowledge(input);
    },
    dismissActionCenterItem: (
      _root: unknown,
      { input }: { input: Parameters<ActionCenterService["dismiss"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.dismiss(input);
    },
  },
  Subscription: {
    actionCenterSettingsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeSettings();
      },
    },
    actionCenterChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
      resolve: () => true,
    },
  },
});
