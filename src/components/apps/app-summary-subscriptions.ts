import {
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

const APP_SUMMARY_SUBSCRIPTIONS = [
  "subscription AppSummaryAppsChanged { appsChanged { id } }",
  "subscription AppSummaryCodebasesChanged { codebaseOverviewChanged { codebaseId repositoryId } }",
  "subscription AppSummaryWorktreesChanged { worktreeOverviewChanged { worktreeId codebaseId } }",
  "subscription AppSummaryRunsChanged($appId: ID) { agentRunListChanged(appId: $appId) }",
  "subscription AppSummaryBuildsChanged { buildsChanged { id repositoryId } }",
] as const;

type AppScope = {
  id: string;
  repositories: Array<{ id: string; codebases: Array<{ id: string }> }>;
};
type Change = {
  id?: string;
  repositoryId?: string;
  codebaseId?: string;
  codebase?: { id: string };
  worktree?: { codebaseId: string };
};

export function subscribeToAppSummaryChanges(
  onChange: (signal: AbortSignal) => void | Promise<unknown>,
  getScope?: () => AppScope | null,
  appId?: string,
) {
  const refresh = createRefreshCoalescer(onChange);
  const subscriptions = controlPlaneSubscriptions();
  const unsubscribers = APP_SUMMARY_SUBSCRIPTIONS.map((query, index) =>
    subscriptions.subscribe(
      {
        query,
        ...(index === 3 ? { variables: { appId: appId ?? null } } : {}),
      },
      {
        next: (result) => {
          const scope = getScope?.();
          const change = Object.values(result?.data ?? {})[0] as
            Change | null | undefined;
          if (scope && change) {
            if (index === 0 && change.id && change.id !== scope.id) return;
            if (index > 0) {
              if (
                change.repositoryId &&
                !scope.repositories.some(({ id }) => id === change.repositoryId)
              )
                return;
              const codebaseId =
                change.codebaseId ??
                change.codebase?.id ??
                change.worktree?.codebaseId;
              if (
                codebaseId &&
                !scope.repositories.some(({ codebases }) =>
                  codebases.some(({ id }) => id === codebaseId),
                )
              )
                return;
            }
          }
          void refresh.refresh();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    ),
  );
  const recover = onControlPlaneRecovery(() => void refresh.refresh());
  return {
    refresh: refresh.refresh,
    dispose() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      recover();
      refresh.dispose();
    },
  };
}
