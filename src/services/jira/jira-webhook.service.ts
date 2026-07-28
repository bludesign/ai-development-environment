import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  JIRA_TICKET_CHANGED_TOPIC,
  JIRA_WEBHOOK_DELIVERY_TOPIC,
} from "@/services/agent-control/event-bus";
import { CREDENTIALS, type CredentialService } from "@/services/credentials";
import type { WorkflowEventsService } from "@/services/workflows/workflow-events.service";

import type { JiraService } from "./jira.service";
import type {
  JiraTicketChange,
  JiraWebhookDeliveryPage,
  JiraWebhookDeliveryView,
  JiraWebhookSecretView,
  JiraWebhookSettingsView,
} from "./types";

const SETTINGS_ID = "default";
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * Jira events that mutate an issue. Each one is worth a forced ticket refresh:
 * that repopulates the cache the UI reads and, as a side effect, makes
 * `JiraService.ticket()` emit the cursor-based `JIRA_*` trigger events.
 */
const ISSUE_MUTATING_EVENTS = new Set([
  "jira:issue_created",
  "jira:issue_updated",
  "comment_created",
  "comment_updated",
  "comment_deleted",
  "worklog_created",
  "worklog_updated",
  "worklog_deleted",
  "jira:worklog_updated",
  "attachment_created",
  "attachment_deleted",
  "issuelink_created",
  "issuelink_deleted",
  "sprint_started",
  "sprint_closed",
]);

/**
 * Events that map to a trigger kind the ticket-refresh path cannot express,
 * either because there is no cursor to compare or no ticket left to fetch.
 */
const DIRECT_TRIGGER_KINDS: Record<string, string> = {
  "jira:issue_created": "JIRA_ISSUE_CREATED",
  "jira:issue_deleted": "JIRA_ISSUE_DELETED",
  comment_created: "JIRA_ISSUE_COMMAND",
  attachment_created: "JIRA_ATTACHMENT_ADDED",
  issuelink_created: "JIRA_ISSUE_LINKED",
};

export const JIRA_WEBHOOK_PATH = "/api/public/jira/webhook";

export const RECOMMENDED_JIRA_WEBHOOK_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "worklog_created",
  "attachment_created",
  "issuelink_created",
  "sprint_started",
  "sprint_closed",
] as const;

export type JiraWebhookInput = {
  body: Uint8Array;
  signature: string | null;
  deliveryId: string | null;
  retryCount: string | null;
};

export type JiraWebhookResult = {
  outcome: "DUPLICATE" | "IGNORED" | "PROCESSED";
  event: string | null;
  issueKey: string | null;
  triggersRecorded: number;
};

function secureEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function issueKeyOf(payload: Record<string, unknown>): string | null {
  const issue = record(payload.issue);
  const key = text(issue?.key)?.toUpperCase() ?? null;
  return key && ISSUE_KEY_PATTERN.test(key) ? key : null;
}

function projectKeyOf(payload: Record<string, unknown>): string | null {
  const issue = record(payload.issue);
  const fields = record(issue?.fields);
  const project = record(fields?.project) ?? record(payload.project);
  return text(project?.key)?.toUpperCase() ?? null;
}

function person(value: unknown): {
  accountId: string | null;
  displayName: string | null;
} | null {
  const source = record(value);
  if (!source) return null;
  return {
    accountId: text(source.accountId),
    displayName: text(source.displayName),
  };
}

export class JiraWebhookService {
  constructor(
    private readonly jira: JiraService,
    private readonly credentials: CredentialService,
    private readonly workflowEvents?: WorkflowEventsService,
  ) {}

  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------

  async webhooksEnabled(): Promise<boolean> {
    const prisma = await getPrismaClient();
    const settings = await prisma.jiraSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { webhookEnabled: true },
    });
    if (!settings?.webhookEnabled) return false;
    return this.credentials.isConfigured(CREDENTIALS.jiraWebhookSecret);
  }

  async getWebhookSettings(): Promise<JiraWebhookSettingsView> {
    const prisma = await getPrismaClient();
    const [settings, secretConfigured, latest] = await Promise.all([
      prisma.jiraSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID },
        update: {},
      }),
      this.credentials.isConfigured(CREDENTIALS.jiraWebhookSecret),
      prisma.jiraWebhookDelivery.findFirst({
        orderBy: [{ receivedAt: "desc" }, { deliveryId: "desc" }],
      }),
    ]);
    return {
      enabled: settings.webhookEnabled && secretConfigured,
      secretConfigured,
      configuredAt: settings.webhookConfiguredAt?.toISOString() ?? null,
      lastReceivedAt: latest?.receivedAt.toISOString() ?? null,
      lastOutcome: latest?.outcome ?? null,
      lastError: latest?.error ?? null,
    };
  }

  /**
   * Jira Cloud cannot be configured remotely with an API token — the dynamic
   * webhook REST API needs an OAuth 2.0 or Connect app. So this only mints the
   * shared secret; the user pastes it, and the URL, into Jira's admin UI. The
   * plaintext secret is returned exactly once and never stored in readable form.
   */
  async enableWebhook(): Promise<JiraWebhookSecretView> {
    const secret = randomBytes(32).toString("base64url");
    await this.credentials.setText(
      CREDENTIALS.jiraWebhookSecret,
      secret,
      async (transaction) => {
        await transaction.jiraSettings.upsert({
          where: { id: SETTINGS_ID },
          create: {
            id: SETTINGS_ID,
            webhookEnabled: true,
            webhookConfiguredAt: new Date(),
          },
          update: { webhookEnabled: true, webhookConfiguredAt: new Date() },
        });
      },
    );
    return { settings: await this.getWebhookSettings(), secret };
  }

  async rotateSecret(): Promise<JiraWebhookSecretView> {
    if (!(await this.credentials.isConfigured(CREDENTIALS.jiraWebhookSecret))) {
      throw new Error("The Jira webhook is not configured");
    }
    return this.enableWebhook();
  }

  async disableWebhook(): Promise<JiraWebhookSettingsView> {
    await this.credentials.delete(
      CREDENTIALS.jiraWebhookSecret,
      async (transaction) => {
        await transaction.jiraSettings.upsert({
          where: { id: SETTINGS_ID },
          create: { id: SETTINGS_ID },
          update: { webhookEnabled: false, webhookConfiguredAt: null },
        });
      },
    );
    return this.getWebhookSettings();
  }

  // ---------------------------------------------------------------------
  // Delivery log
  // ---------------------------------------------------------------------

  async deliveries(limit = 50, offset = 0): Promise<JiraWebhookDeliveryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Limit must be an integer from 1 to 100");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("Offset must be a non-negative integer");
    }
    const enabled = await this.webhooksEnabled();
    if (!enabled) {
      return { enabled, items: [], total: 0, limit, offset };
    }
    const prisma = await getPrismaClient();
    const [items, total] = await Promise.all([
      prisma.jiraWebhookDelivery.findMany({
        orderBy: [{ receivedAt: "desc" }, { deliveryId: "desc" }],
        take: limit,
        skip: offset,
      }),
      prisma.jiraWebhookDelivery.count(),
    ]);
    return { enabled, items: items.map(deliveryView), total, limit, offset };
  }

  async clearDeliveries(): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.jiraWebhookDelivery.deleteMany();
    return true;
  }

  private async prune(): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.jiraWebhookDelivery.deleteMany({
      where: { receivedAt: { lt: new Date(Date.now() - RETENTION_MS) } },
    });
  }

  // ---------------------------------------------------------------------
  // Ingress
  // ---------------------------------------------------------------------

  async handleWebhook(input: JiraWebhookInput): Promise<JiraWebhookResult> {
    const secret = await this.credentials.getText(
      CREDENTIALS.jiraWebhookSecret,
    );
    if (!secret) throw new Error("Jira webhook is not configured");
    if (!input.signature?.startsWith("sha256=")) {
      throw new Error("Jira webhook signature is missing");
    }
    const expected = `sha256=${createHmac("sha256", secret)
      .update(input.body)
      .digest("hex")}`;
    if (!secureEqual(expected, input.signature)) {
      throw new Error("Jira webhook signature is invalid");
    }
    if (!input.deliveryId?.trim()) {
      throw new Error("Jira delivery ID is missing");
    }

    const prisma = await getPrismaClient();
    const deliveryId = input.deliveryId.trim();
    const retryCount = Number.parseInt(input.retryCount ?? "", 10);
    const retries = Number.isInteger(retryCount) ? retryCount : null;

    try {
      await prisma.jiraWebhookDelivery.create({
        data: {
          deliveryId,
          event: "unknown",
          outcome: "RECEIVED",
          retryCount: retries,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // A delivery that already reached a terminal outcome is a Jira retry of
      // work we finished; anything else is a genuine redelivery worth redoing.
      const retried = await prisma.jiraWebhookDelivery.updateMany({
        where: { deliveryId, outcome: { notIn: ["PROCESSED", "IGNORED"] } },
        data: {
          event: "unknown",
          issueKey: null,
          projectKey: null,
          retryCount: retries,
          outcome: "RECEIVED",
          error: null,
          receivedAt: new Date(),
          processedAt: null,
        },
      });
      if (retried.count === 0) {
        return {
          outcome: "DUPLICATE",
          event: null,
          issueKey: null,
          triggersRecorded: 0,
        };
      }
    }

    const finish = async (
      outcome: string,
      error: string | null = null,
    ): Promise<void> => {
      const delivery = await prisma.jiraWebhookDelivery.update({
        where: { deliveryId },
        data: { outcome, error, processedAt: new Date() },
      });
      agentEventBus.publish(JIRA_WEBHOOK_DELIVERY_TOPIC, {
        jiraWebhookDeliveryChanged: deliveryView(delivery),
      });
    };

    try {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(
          Buffer.from(input.body).toString("utf8"),
        ) as Record<string, unknown>;
      } catch {
        throw new Error("Jira webhook payload is invalid JSON");
      }
      const event = text(payload.webhookEvent);
      const issueKey = issueKeyOf(payload);
      const projectKey = projectKeyOf(payload);
      await prisma.jiraWebhookDelivery.update({
        where: { deliveryId },
        data: { event: event ?? "unknown", issueKey, projectKey },
      });

      if (!event) {
        await finish("IGNORED", "Payload has no webhookEvent");
        return { outcome: "IGNORED", event, issueKey, triggersRecorded: 0 };
      }
      const known =
        ISSUE_MUTATING_EVENTS.has(event) || event === "jira:issue_deleted";
      if (!known) {
        await finish("IGNORED", `Unhandled Jira event ${event}`);
        return { outcome: "IGNORED", event, issueKey, triggersRecorded: 0 };
      }
      if (!issueKey) {
        await finish("IGNORED", "Payload has no issue key");
        return { outcome: "IGNORED", event, issueKey, triggersRecorded: 0 };
      }

      // Refreshing the ticket both repopulates the cache the Jira pages read
      // and makes JiraService emit the existing cursor-based JIRA_* triggers.
      if (event === "jira:issue_deleted") {
        await this.jira.deleteCachedTicket(issueKey);
      } else if (ISSUE_MUTATING_EVENTS.has(event)) {
        await this.jira.refreshCachedTicket(issueKey);
      }

      const triggersRecorded = await this.recordWebhookTrigger({
        event,
        deliveryId,
        issueKey,
        projectKey,
        retries,
        payload,
      });

      agentEventBus.publish(JIRA_TICKET_CHANGED_TOPIC, {
        jiraTicketChanged: {
          issueKey,
          projectKey,
          event,
        } satisfies JiraTicketChange,
      });

      await finish("PROCESSED");
      void this.prune().catch(() => undefined);
      return { outcome: "PROCESSED", event, issueKey, triggersRecorded };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finish("ERROR", message);
      throw error;
    }
  }

  /**
   * Records the trigger kinds that the ticket-refresh path cannot produce.
   * The ten pre-existing `JIRA_*` kinds are emitted by
   * `JiraService.recordTicketWorkflowEvents` during the refresh above, so they
   * are deliberately not duplicated here.
   */
  private async recordWebhookTrigger(input: {
    event: string;
    deliveryId: string;
    issueKey: string;
    projectKey: string | null;
    retries: number | null;
    payload: Record<string, unknown>;
  }): Promise<number> {
    if (!this.workflowEvents) return 0;
    const kind = DIRECT_TRIGGER_KINDS[input.event];
    if (!kind) return 0;

    const { payload } = input;
    const issue = record(payload.issue);
    const fields = record(issue?.fields);
    const comment = record(payload.comment);
    const attachment = record(payload.attachment);
    const issueLink = record(payload.issueLink);
    const status = record(fields?.status);

    const sessionData = {
      ticket: {
        key: input.issueKey,
        title: text(fields?.summary),
        type: text(record(fields?.issuetype)?.name),
        status: text(status?.name),
        statusId: text(status?.id),
        statusCategory: text(record(status?.statusCategory)?.key),
        assignee: text(record(fields?.assignee)?.displayName),
        assigneeAccountId: text(record(fields?.assignee)?.accountId),
        labels: Array.isArray(fields?.labels) ? fields.labels : [],
        projectKey: input.projectKey,
        url: null,
      },
      comment: comment
        ? {
            id: text(comment.id),
            body: text(comment.body) ?? "",
            author: person(comment.author),
          }
        : null,
      attachment: attachment
        ? {
            id: text(attachment.id),
            filename: text(attachment.filename),
            mimeType: text(attachment.mimeType),
            author: person(attachment.author),
          }
        : null,
      link: issueLink
        ? {
            id: text(issueLink.id),
            type: text(record(issueLink.issueLinkType)?.name),
            sourceIssueId: text(issueLink.sourceIssueId),
            destinationIssueId: text(issueLink.destinationIssueId),
          }
        : null,
      user: person(payload.user),
    };

    const event = await this.workflowEvents.record({
      kind,
      subjectKey: input.issueKey,
      dedupeKey: `jira-webhook-trigger:${input.deliveryId}:${kind}`,
      payload: {
        ...sessionData,
        sessionData,
        cursorValue: `${input.deliveryId}:${kind}`,
        webhook: {
          event: input.event,
          deliveryId: input.deliveryId,
          retryCount: input.retries,
        },
      },
    });
    return event ? 1 : 0;
  }
}

function deliveryView(delivery: {
  deliveryId: string;
  event: string;
  issueKey: string | null;
  projectKey: string | null;
  retryCount: number | null;
  outcome: string;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}): JiraWebhookDeliveryView {
  return {
    deliveryId: delivery.deliveryId,
    event: delivery.event,
    issueKey: delivery.issueKey,
    projectKey: delivery.projectKey,
    retryCount: delivery.retryCount,
    outcome: delivery.outcome,
    error: delivery.error,
    receivedAt: delivery.receivedAt.toISOString(),
    processedAt: delivery.processedAt?.toISOString() ?? null,
  };
}

export function subscribeJiraWebhookDeliveries() {
  return agentEventBus.iterate<{
    jiraWebhookDeliveryChanged: JiraWebhookDeliveryView;
  }>(JIRA_WEBHOOK_DELIVERY_TOPIC);
}

export function subscribeJiraTicketChanges() {
  return agentEventBus.iterate<{ jiraTicketChanged: JiraTicketChange }>(
    JIRA_TICKET_CHANGED_TOPIC,
  );
}
