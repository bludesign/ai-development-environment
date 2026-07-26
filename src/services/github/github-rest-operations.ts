export const GITHUB_REST_OPERATIONS = {
  actions: {
    cancelWorkflowRun: "actions.cancelWorkflowRun",
    forceCancelWorkflowRun: "actions.forceCancelWorkflowRun",
    getJobForWorkflowRun: "actions.getJobForWorkflowRun",
    getWorkflowRun: "actions.getWorkflowRun",
    getWorkflowRunAttempt: "actions.getWorkflowRunAttempt",
    listJobsForWorkflowRun: "actions.listJobsForWorkflowRun",
    listJobsForWorkflowRunAttempt: "actions.listJobsForWorkflowRunAttempt",
    listRepoWorkflows: "actions.listRepoWorkflows",
    listWorkflowRuns: "actions.listWorkflowRuns",
    listWorkflowRunsForRepo: "actions.listWorkflowRunsForRepo",
    reRunJobForWorkflowRun: "actions.reRunJobForWorkflowRun",
    reRunWorkflow: "actions.reRunWorkflow",
    reRunWorkflowFailedJobs: "actions.reRunWorkflowFailedJobs",
  },
  apps: {
    createInstallationAccessToken: "apps.createInstallationAccessToken",
    getInstallation: "apps.getInstallation",
    updateWebhookConfigForApp: "apps.updateWebhookConfigForApp",
  },
  repos: {
    listPullRequestsAssociatedWithCommit:
      "repos.listPullRequestsAssociatedWithCommit",
  },
  users: {
    listEmailsForAuthenticatedUser: "users.listEmailsForAuthenticatedUser",
  },
} as const;

type GitHubRestOperationCatalog = typeof GITHUB_REST_OPERATIONS;

export type GitHubRestOperation = {
  [
    Namespace in keyof GitHubRestOperationCatalog
  ]: GitHubRestOperationCatalog[Namespace][keyof GitHubRestOperationCatalog[Namespace]];
}[keyof GitHubRestOperationCatalog];
