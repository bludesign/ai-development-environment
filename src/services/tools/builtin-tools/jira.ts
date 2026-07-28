import * as z from "zod/v4";

import type { JiraService, JiraWebhookService } from "@/services/jira";

import {
  defineTool,
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { redactSensitiveToolOutput, serviceTool } from "./service-tool";

const issueInput = z.object({ issueKey: z.string().min(1) });
const jiraText = z.object({ format: z.string().min(1), value: z.string() });
const sourceKind = z.enum(["JQL", "BOARD"]);

function createJiraAdministrationGroup(
  service: JiraService,
  webhooks: JiraWebhookService,
): BuiltInToolGroup {
  return {
    id: "builtin:jira:administration",
    name: "Jira Administration",
    children: [],
    tools: [
      serviceTool({
        name: "get_jira_webhook_settings",
        title: "Get Jira webhook settings",
        description:
          "Get the Jira webhook configuration and the outcome of the most recent delivery.",
        inputSchema: z.object({}),
        service: webhooks,
        method: "getWebhookSettings",
        arguments: () => [],
        resultKey: "settings",
        annotations: READ_ONLY_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_webhook_deliveries",
        title: "Get Jira webhook deliveries",
        description:
          "List Jira webhook deliveries with their event, issue, and outcome.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).default(0),
        }),
        service: webhooks,
        method: "deliveries",
        arguments: ({ limit, offset }) => [limit, offset],
        resultKey: "page",
        annotations: READ_ONLY_ANNOTATIONS,
      }),
      serviceTool({
        name: "clear_jira_webhook_deliveries",
        title: "Clear Jira webhook deliveries",
        description: "Delete the Jira webhook delivery history.",
        inputSchema: z.object({}),
        service: webhooks,
        method: "clearDeliveries",
        arguments: () => [],
        resultKey: "cleared",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      defineTool({
        name: "rotate_jira_webhook_secret",
        title: "Rotate Jira webhook secret",
        description:
          "Replace the Jira webhook signing secret. The new secret is only readable in Settings — deliveries fail until it is pasted into Jira.",
        inputSchema: z.object({}),
        outputSchema: z.object({ rotated: z.boolean() }),
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
        // Deliberately does not return the secret: an MCP client is the wrong
        // place to hand out a live signing key.
        handler: async () => {
          await webhooks.rotateSecret();
          return { rotated: true };
        },
      }),
      serviceTool({
        name: "disable_jira_webhook",
        title: "Disable Jira webhook",
        description:
          "Delete the Jira webhook signing secret and stop accepting deliveries.",
        inputSchema: z.object({}),
        service: webhooks,
        method: "disableWebhook",
        arguments: () => [],
        resultKey: "settings",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_available_projects",
        title: "Get Jira available projects",
        description:
          "List Jira projects that can be added, including ones not configured yet.",
        inputSchema: z.object({}),
        service,
        method: "availableProjects",
        arguments: () => [],
        resultKey: "projects",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_project_statuses",
        title: "Get Jira project statuses",
        description:
          "List the statuses available in a configured Jira project.",
        inputSchema: z.object({ projectId: z.string().min(1) }),
        service,
        method: "projectStatuses",
        arguments: ({ projectId }) => [projectId],
        resultKey: "statuses",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "add_jira_project",
        title: "Add Jira project",
        description: "Add a Jira project by its Jira ID.",
        inputSchema: z.object({ jiraId: z.string().min(1) }),
        service,
        method: "addProject",
        arguments: ({ jiraId }) => [jiraId],
        resultKey: "projects",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "remove_jira_project",
        title: "Remove Jira project",
        description:
          "Remove a configured Jira project along with its sources and cached tickets.",
        inputSchema: z.object({ projectId: z.string().min(1) }),
        service,
        method: "removeProject",
        arguments: ({ projectId }) => [projectId],
        resultKey: "projects",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_jira_project_display_settings",
        title: "Update Jira project display settings",
        description:
          "Set the assignment filter, completed statuses, and done status for a Jira project.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          ticketAssignmentFilter: z.enum([
            "ALL",
            "ASSIGNED_TO_ME",
            "UNASSIGNED",
          ]),
          hideCompletedTickets: z.boolean(),
          completedStatusIds: z.array(z.string()),
          doneStatusId: z.string().nullable().optional(),
        }),
        service,
        method: "updateProjectDisplaySettings",
        resultKey: "projects",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_jira_project_branch_naming",
        title: "Update Jira project branch naming",
        description:
          "Set the branch-naming script used to derive branch names for a Jira project.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          branchNamingScript: z.string(),
        }),
        service,
        method: "updateProjectBranchNaming",
        arguments: ({ projectId, branchNamingScript }) => [
          projectId,
          branchNamingScript,
        ],
        resultKey: "projects",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "create_jira_source",
        title: "Create Jira source",
        description:
          "Create a ticket-board source for a Jira project from a JQL query or a board URL.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          name: z.string().min(1),
          kind: sourceKind,
          value: z.string().min(1),
        }),
        service,
        method: "createSource",
        resultKey: "projects",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_jira_source",
        title: "Update Jira source",
        description: "Update a Jira ticket-board source and clear its cache.",
        inputSchema: z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          kind: sourceKind,
          value: z.string().min(1),
        }),
        service,
        method: "updateSource",
        resultKey: "projects",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_jira_source",
        title: "Delete Jira source",
        description:
          "Delete a Jira ticket-board source and the cached tickets only it referenced.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "deleteSource",
        arguments: ({ id }) => [id],
        resultKey: "projects",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_jira_cache_ttl",
        title: "Update Jira cache TTL",
        description:
          "Set how long Jira API responses stay cached, in minutes (1 to 1440).",
        inputSchema: z.object({
          ttlMinutes: z.number().int().min(1).max(1440),
        }),
        service,
        method: "updateCacheTtl",
        arguments: ({ ttlMinutes }) => [ttlMinutes],
        resultKey: "settings",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "refresh_jira_cached_ticket",
        title: "Refresh Jira cached ticket",
        description:
          "Discard the cached copy of a Jira ticket and fetch it again from Jira.",
        inputSchema: issueInput,
        service,
        method: "refreshCachedTicket",
        arguments: ({ issueKey }) => [issueKey],
        resultKey: "ticket",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_jira_cached_ticket",
        title: "Delete Jira cached ticket",
        description:
          "Remove a Jira ticket from the local cache without touching Jira.",
        inputSchema: issueInput,
        service,
        method: "deleteCachedTicket",
        arguments: ({ issueKey }) => [issueKey],
        resultKey: "deleted",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
    ],
  };
}

export function createJiraToolGroup(
  service: JiraService,
  webhooks: JiraWebhookService,
): BuiltInToolGroup {
  return {
    id: "builtin:jira",
    name: "Jira",
    children: [createJiraAdministrationGroup(service, webhooks)],
    tools: [
      serviceTool({
        name: "get_jira_status",
        title: "Get Jira status",
        description:
          "Test the configured Jira connection without exposing credentials.",
        inputSchema: z.object({}),
        service,
        method: "testConnection",
        arguments: () => [],
        resultKey: "status",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_projects",
        title: "Get Jira projects",
        description: "List configured Jira projects and display settings.",
        inputSchema: z.object({}),
        service,
        method: "listProjects",
        arguments: () => [],
        resultKey: "projects",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      defineTool({
        name: "get_jira_sources",
        title: "Get Jira sources",
        description:
          "List ticket-board sources configured across Jira projects.",
        inputSchema: z.object({}),
        outputSchema: z.object({ sources: z.unknown() }),
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
        handler: async () => ({
          sources: redactSensitiveToolOutput(
            (await service.listProjects()).flatMap(
              (project) => project.sources,
            ),
          ),
        }),
      }),
      serviceTool({
        name: "get_jira_board",
        title: "Get Jira board",
        description: "Get tickets for a configured Jira source.",
        inputSchema: z.object({
          sourceId: z.string().min(1),
          refresh: z.boolean().default(false),
        }),
        service,
        method: "ticketBoard",
        arguments: ({ sourceId, refresh }) => [sourceId, refresh],
        resultKey: "board",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_ticket",
        title: "Get Jira ticket",
        description: "Get a Jira ticket and its normalized editable metadata.",
        inputSchema: issueInput.extend({ refresh: z.boolean().default(false) }),
        service,
        method: "ticket",
        arguments: ({ issueKey, refresh }) => [issueKey, refresh],
        resultKey: "ticket",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_assignable_users",
        title: "Get Jira assignable users",
        description: "Search users who can be assigned to a Jira ticket.",
        inputSchema: issueInput.extend({ query: z.string().default("") }),
        service,
        method: "assignableUsers",
        arguments: ({ issueKey, query }) => [issueKey, query],
        resultKey: "users",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_transitions",
        title: "Get Jira transitions",
        description: "Get available transitions for a Jira ticket.",
        inputSchema: issueInput,
        service,
        method: "ticketTransitions",
        arguments: ({ issueKey }) => [issueKey],
        resultKey: "transitions",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_edit_fields",
        title: "Get Jira edit fields",
        description:
          "Get editable fields and allowed values for a Jira ticket.",
        inputSchema: issueInput,
        service,
        method: "ticketEditFields",
        arguments: ({ issueKey }) => [issueKey],
        resultKey: "fields",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_ticket_changes",
        title: "Get Jira ticket changes",
        description: "Get paginated Jira ticket changelog entries.",
        inputSchema: issueInput.extend({
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        }),
        service,
        method: "ticketChanges",
        arguments: (value) => [value.issueKey, value.limit, value.offset],
        resultKey: "page",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_jira_worklogs",
        title: "Get Jira worklogs",
        description: "Get paginated worklogs for a Jira ticket.",
        inputSchema: issueInput.extend({
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        }),
        service,
        method: "ticketWorklogs",
        arguments: (value) => [value.issueKey, value.limit, value.offset],
        resultKey: "page",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "add_jira_comment",
        title: "Add Jira comment",
        description: "Add a plain-text or Markdown comment to a Jira ticket.",
        inputSchema: issueInput.extend({ content: jiraText }),
        service,
        method: "addComment",
        arguments: ({ issueKey, content }) => [issueKey, content],
        resultKey: "ticket",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "assign_jira_ticket",
        title: "Assign Jira ticket",
        description: "Assign or unassign a Jira ticket.",
        inputSchema: issueInput.extend({
          accountId: z.string().nullable().optional(),
        }),
        service,
        method: "assignTicket",
        arguments: ({ issueKey, accountId }) => [issueKey, accountId ?? null],
        resultKey: "ticket",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "transition_jira_ticket",
        title: "Transition Jira ticket",
        description: "Apply an available status transition to a Jira ticket.",
        inputSchema: issueInput.extend({ transitionId: z.string().min(1) }),
        service,
        method: "transitionTicket",
        arguments: ({ issueKey, transitionId }) => [issueKey, transitionId],
        resultKey: "ticket",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_jira_ticket",
        title: "Update Jira ticket",
        description: "Update supported editable fields on a Jira ticket.",
        inputSchema: issueInput.extend({
          summary: z.string().nullable().optional(),
          description: jiraText.nullable().optional(),
          priorityId: z.string().nullable().optional(),
          labels: z.array(z.string()).nullable().optional(),
          componentIds: z.array(z.string()).nullable().optional(),
          fixVersionIds: z.array(z.string()).nullable().optional(),
          affectedVersionIds: z.array(z.string()).nullable().optional(),
          dueDate: z.string().nullable().optional(),
        }),
        service,
        method: "updateTicket",
        resultKey: "ticket",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "transition_jira_ticket_to_done",
        title: "Transition Jira ticket to done",
        description:
          "Move a Jira ticket to the done status configured for its project.",
        inputSchema: issueInput,
        service,
        method: "transitionTicketToConfiguredDone",
        arguments: ({ issueKey }) => [issueKey],
        resultKey: "ticket",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "resolve_jira_branch",
        title: "Resolve Jira branch",
        description: "Resolve the configured branch name for a Jira ticket.",
        inputSchema: issueInput,
        service,
        method: "branchTicket",
        arguments: ({ issueKey }) => [issueKey],
        resultKey: "branch",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "create_jira_ticket",
        title: "Create Jira ticket",
        description:
          "Create a Jira ticket with typed core fields and optional additional fields.",
        inputSchema: z.object({
          projectKey: z.string().min(1),
          issueTypeId: z.string().min(1),
          summary: z.string().min(1),
          description: jiraText.nullable().optional(),
          fields: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
        service,
        method: "createTicket",
        resultKey: "ticket",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "add_jira_worklog",
        title: "Add Jira worklog",
        description: "Add a time-spent worklog to a Jira ticket.",
        inputSchema: issueInput.extend({
          timeSpentSeconds: z.number().int().positive(),
          startedAt: z.string().nullable().optional(),
          comment: jiraText.nullable().optional(),
        }),
        service,
        method: "addWorklog",
        resultKey: "ticket",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "link_jira_tickets",
        title: "Link Jira tickets",
        description: "Create a typed relationship between two Jira tickets.",
        inputSchema: z.object({
          inwardIssueKey: z.string().min(1),
          outwardIssueKey: z.string().min(1),
          linkType: z.string().min(1),
        }),
        service,
        method: "linkTickets",
        resultKey: "ticket",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
    ],
  };
}
