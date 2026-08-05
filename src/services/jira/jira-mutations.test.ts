import { describe, expect, test, vi } from "vitest";

import {
  agentEventBus,
  JIRA_TICKET_CHANGED_TOPIC,
} from "@/services/agent-control/event-bus";

import { JiraService } from "./jira.service";
import type {
  JiraEditField,
  JiraTicketChange,
  JiraTicketDetail,
} from "./types";

const ticket = { key: "APP-1" } as JiraTicketDetail;

type MutationHarness = {
  getClients(): Promise<{
    version3: {
      issueComments: { addComment: ReturnType<typeof vi.fn> };
      issues: {
        assignIssue: ReturnType<typeof vi.fn>;
        doTransition: ReturnType<typeof vi.fn>;
        editIssue: ReturnType<typeof vi.fn>;
      };
    };
  }>;
  mutateTicket(
    issueKey: string,
    operation: string,
    mutation: () => Promise<void>,
  ): Promise<JiraTicketDetail>;
  ticketEditFields(issueKey: string): Promise<JiraEditField[]>;
  ticketTransitions(issueKey: string): Promise<
    Array<{
      id: string;
      name: string;
      toStatusId: string;
      toStatus: string;
      toStatusCategory: string;
      hasScreen: boolean;
      requiredFields: string[];
    }>
  >;
};

function harness() {
  const addComment = vi.fn().mockResolvedValue({});
  const assignIssue = vi.fn().mockResolvedValue(undefined);
  const doTransition = vi.fn().mockResolvedValue(undefined);
  const editIssue = vi.fn().mockResolvedValue(undefined);
  const service = new JiraService() as unknown as MutationHarness;
  service.getClients = vi.fn().mockResolvedValue({
    version3: {
      issueComments: { addComment },
      issues: { assignIssue, doTransition, editIssue },
    },
  });
  service.mutateTicket = vi.fn(async (_key, _operation, mutation) => {
    await mutation();
    return ticket;
  });
  return {
    service: service as unknown as JiraService,
    internal: service,
    addComment,
    assignIssue,
    doTransition,
    editIssue,
  };
}

describe("Jira write operations", () => {
  test("submits Markdown comments as ADF and assignments by account ID", async () => {
    const { service, addComment, assignIssue } = harness();
    await service.addComment("app-1", {
      format: "MARKDOWN",
      value: "**Ready**",
    });
    await service.assignTicket("APP-1", "account-1");
    expect(addComment).toHaveBeenCalledWith({
      issueIdOrKey: "APP-1",
      comment: expect.objectContaining({ type: "doc", version: 1 }),
    });
    expect(assignIssue).toHaveBeenCalledWith({
      issueIdOrKey: "APP-1",
      accountId: "account-1",
    });
  });

  test("validates and maps core field edits to Jira REST fields", async () => {
    const { service, internal, editIssue } = harness();
    internal.ticketEditFields = vi.fn().mockResolvedValue([
      {
        id: "summary",
        name: "Summary",
        required: true,
        schemaType: "string",
        allowedValues: [],
      },
      {
        id: "priority",
        name: "Priority",
        required: false,
        schemaType: "priority",
        allowedValues: [{ id: "2", name: "High" }],
      },
      {
        id: "labels",
        name: "Labels",
        required: false,
        schemaType: "array",
        allowedValues: [],
      },
      {
        id: "duedate",
        name: "Due date",
        required: false,
        schemaType: "date",
        allowedValues: [],
      },
    ]);
    await service.updateTicket({
      issueKey: "APP-1",
      summary: "Updated",
      priorityId: "2",
      labels: ["api", "api", "ready"],
      dueDate: "2026-08-01",
    });
    expect(editIssue).toHaveBeenCalledWith({
      issueIdOrKey: "APP-1",
      fields: {
        summary: "Updated",
        priority: { id: "2" },
        labels: ["api", "ready"],
        duedate: "2026-08-01",
      },
    });
  });

  test("blocks transitions whose Jira screen requires unsupported fields", async () => {
    const { service, internal, doTransition } = harness();
    internal.ticketTransitions = vi.fn().mockResolvedValue([
      {
        id: "31",
        name: "Resolve",
        toStatusId: "done",
        toStatus: "Done",
        toStatusCategory: "done",
        hasScreen: true,
        requiredFields: ["Resolution"],
      },
    ]);
    await expect(service.transitionTicket("APP-1", "31")).rejects.toThrow(
      "Resolution",
    );
    expect(doTransition).not.toHaveBeenCalled();
  });

  test("publishes locally initiated ticket changes after refreshing the cache", async () => {
    type InternalMutationHarness = {
      requireCredentials(): Promise<{ apiToken: string }>;
      logCall(input: unknown): Promise<void>;
      invalidateIssueCaches(issueKey: string): Promise<void>;
      ticket(issueKey: string, force: boolean): Promise<JiraTicketDetail>;
      mutateTicket(
        issueKey: string,
        operation: string,
        mutation: () => Promise<void>,
      ): Promise<JiraTicketDetail>;
    };
    const internal = new JiraService() as unknown as InternalMutationHarness;
    internal.requireCredentials = vi
      .fn()
      .mockResolvedValue({ apiToken: "secret" });
    internal.logCall = vi.fn().mockResolvedValue(undefined);
    internal.invalidateIssueCaches = vi.fn().mockResolvedValue(undefined);
    internal.ticket = vi.fn().mockResolvedValue({
      key: "APP-1",
      projectKey: "APP",
    } as JiraTicketDetail);
    const mutation = vi.fn().mockResolvedValue(undefined);
    const changes = agentEventBus.iterate<{
      jiraTicketChanged: JiraTicketChange;
    }>(JIRA_TICKET_CHANGED_TOPIC);
    const next = changes.next();

    await internal.mutateTicket("APP-1", "TRANSITION_ISSUE", mutation);

    expect(mutation).toHaveBeenCalledTimes(1);
    await expect(next).resolves.toEqual({
      done: false,
      value: {
        jiraTicketChanged: {
          issueKey: "APP-1",
          projectKey: "APP",
          event: "aide:transition_issue",
        },
      },
    });
    await changes.return?.();
  });
});
