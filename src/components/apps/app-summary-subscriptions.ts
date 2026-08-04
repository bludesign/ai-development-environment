import { controlPlaneSubscriptions } from "@/lib/control-plane-client";

const APP_SUMMARY_SUBSCRIPTIONS = [
  "subscription AppSummaryAppsChanged { appsChanged { id } }",
  "subscription AppSummaryCodebasesChanged { codebaseOverviewChanged { codebaseId repositoryId } }",
  "subscription AppSummaryWorktreesChanged { worktreeOverviewChanged { worktreeId codebaseId } }",
  "subscription AppSummaryRunsChanged { agentRunsChanged { id } }",
  "subscription AppSummaryBuildsChanged { buildsChanged { id } }",
] as const;

export function subscribeToAppSummaryChanges(onChange: () => void) {
  const subscriptions = controlPlaneSubscriptions();
  const unsubscribers = APP_SUMMARY_SUBSCRIPTIONS.map((query) =>
    subscriptions.subscribe(
      { query },
      {
        next: onChange,
        error: () => undefined,
        complete: () => undefined,
      },
    ),
  );
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
