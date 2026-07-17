import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { JiraService } from "@/services/jira";
import type {
  JiraSourceKind,
  JiraTicketAssignmentFilter,
} from "@/services/jira";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createJiraResolvers = (jiraService: JiraService) => ({
  Query: {
    jiraSettings: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return jiraService.getSettings();
    },
    jiraAvailableProjects: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.availableProjects();
    },
    jiraProjects: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return jiraService.listProjects();
    },
    jiraProjectStatuses: (
      _root: unknown,
      { projectId }: { projectId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.projectStatuses(projectId);
    },
    jiraTicketBoard: (
      _root: unknown,
      { sourceId }: { sourceId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.ticketBoard(sourceId);
    },
    jiraTicket: (
      _root: unknown,
      { issueKey }: { issueKey: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.ticket(issueKey);
    },
    jiraCacheMetrics: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.cacheMetrics();
    },
    jiraApiCalls: (
      _root: unknown,
      { limit, offset }: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.listApiCalls(limit, offset);
    },
    jiraCachedTickets: (
      _root: unknown,
      { limit, offset }: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.listCachedTickets(limit, offset);
    },
    jiraCachedTicket: (
      _root: unknown,
      { issueKey }: { issueKey: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.cachedTicket(issueKey);
    },
  },
  Mutation: {
    saveJiraSettings: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          siteUrl: string;
          email: string;
          apiToken?: string | null;
          resetSite?: boolean;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.saveSettings(input);
    },
    testJiraConnection: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.testConnection();
    },
    clearJiraCredentials: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.clearCredentials();
    },
    addJiraProject: (
      _root: unknown,
      { jiraId }: { jiraId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.addProject(jiraId);
    },
    removeJiraProject: (
      _root: unknown,
      { projectId }: { projectId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.removeProject(projectId);
    },
    createJiraSource: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          projectId: string;
          name: string;
          kind: JiraSourceKind;
          value: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.createSource(input);
    },
    updateJiraSource: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          id: string;
          name: string;
          kind: JiraSourceKind;
          value: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.updateSource(input);
    },
    deleteJiraSource: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.deleteSource(id);
    },
    updateJiraProjectDisplaySettings: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          projectId: string;
          ticketAssignmentFilter: JiraTicketAssignmentFilter;
          hideCompletedTickets: boolean;
          completedStatusIds: string[];
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.updateProjectDisplaySettings(input);
    },
    updateJiraProjectBranchNaming: (
      _root: unknown,
      {
        projectId,
        branchNamingScript,
      }: { projectId: string; branchNamingScript: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.updateProjectBranchNaming(
        projectId,
        branchNamingScript,
      );
    },
    refreshJiraSource: (
      _root: unknown,
      { sourceId }: { sourceId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.ticketBoard(sourceId, true);
    },
    updateJiraCacheTtl: (
      _root: unknown,
      { ttlMinutes }: { ttlMinutes: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.updateCacheTtl(ttlMinutes);
    },
    clearJiraCache: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.clearCache();
    },
    refreshJiraCachedTicket: (
      _root: unknown,
      { issueKey }: { issueKey: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.refreshCachedTicket(issueKey);
    },
    deleteJiraCachedTicket: (
      _root: unknown,
      { issueKey }: { issueKey: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return jiraService.deleteCachedTicket(issueKey);
    },
  },
});
