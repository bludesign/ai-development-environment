import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  JIRA_TICKET_CHANGED_TOPIC,
  JIRA_WEBHOOK_DELIVERY_TOPIC,
} from "@/services/agent-control/event-bus";
import {
  CREDENTIALS,
  encodeJsonCredential,
  jiraWebhookConnectionSettings,
  readConnectionSettings,
  type CredentialService,
  type JiraWebhookConnectionSettings,
} from "@/services/credentials";
import type { WorkflowEventsService } from "@/services/workflows/workflow-events.service";

import type { JiraService } from "./jira.service";
import type {
  JiraTicketChange,
  JiraWebhookChangelog,
  JiraWebhookDeliveryPage,
  JiraWebhookDeliveryView,
  JiraWebhookRegistrationInput,
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

/** Jira's classic webhook API. The dynamic one needs an OAuth 2.0 app. */
const WEBHOOK_API_PATH = "/rest/webhooks/1.0/webhook";

/** The name and description Jira shows in Settings → System → WebHooks. */
const WEBHOOK_NAME = "AI Development Environment";
const WEBHOOK_DESCRIPTION =
  "Registered by AI Development Environment. Drives Jira workflow triggers and live ticket updates.";

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::1",
  "[::1]",
  "",
]);

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

export class JiraWebhookRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 401 | 503,
  ) {
    super(message);
    this.name = "JiraWebhookRequestError";
  }
}

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

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.length ? value : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function normalizeChangelog(value: unknown): JiraWebhookChangelog | null {
  const changelog = record(value);
  if (!changelog) return null;
  const rawItems = Array.isArray(changelog.items) ? changelog.items : [];
  return {
    id: scalarText(changelog.id),
    items: rawItems
      .map(record)
      .filter((item) => item !== null)
      .map((item) => ({
        field: text(item.field) ?? text(item.fieldId) ?? "Field",
        fieldId: text(item.fieldId),
        fieldType: text(item.fieldtype) ?? text(item.fieldType),
        from: scalarText(item.from),
        fromString: scalarText(item.fromString),
        to: scalarText(item.to),
        toString: scalarText(item.toString),
      })),
  };
}

function storedChangelog(value: string | null): JiraWebhookChangelog | null {
  if (!value) return null;
  try {
    return normalizeChangelog(JSON.parse(value));
  } catch {
    return null;
  }
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

function projectKeyFromIssueKey(issueKey: string): string | null {
  const separator = issueKey.lastIndexOf("-");
  return separator > 0 ? issueKey.slice(0, separator) : null;
}

function issueLinkIssueIds(payload: Record<string, unknown>): string[] {
  const issueLink = record(payload.issueLink);
  return [
    scalarText(issueLink?.sourceIssueId),
    scalarText(issueLink?.destinationIssueId),
  ].filter((value, index, values): value is string =>
    Boolean(value && values.indexOf(value) === index),
  );
}

function sprintIdOf(payload: Record<string, unknown>): number | null {
  const value = scalarText(record(payload.sprint)?.id);
  if (!value) return null;
  const sprintId = Number(value);
  return Number.isSafeInteger(sprintId) && sprintId > 0 ? sprintId : null;
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  return typeof error.status === "number" ? error.status : null;
}

/**
 * Normalizes the address Jira will POST deliveries to. A bare origin gets the
 * ingress path appended; anything else has to already end in it, so a stray
 * value can never point Jira at an unrelated endpoint.
 */
export function normalizeJiraDeliveryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter the public URL of this server");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The webhook URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "The webhook URL must not include credentials, query, or fragment",
    );
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    LOOPBACK_HOSTNAMES.has(host) ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (loopback) {
    // Jira accepts a private address at registration time and then fails every
    // delivery, so catching it here is the only way the user learns about it.
    throw new Error(
      `Jira cannot reach ${url.host}. Expose this server publicly, or set PUBLIC_BASE_URL to its public address.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) return `${url.origin}${JIRA_WEBHOOK_PATH}`;
  if (path.endsWith(JIRA_WEBHOOK_PATH)) return `${url.origin}${path}`;
  throw new Error(`The webhook URL must end with ${JIRA_WEBHOOK_PATH}`);
}

/** Jira reports the new webhook only through the `self` link it returns. */
function webhookIdOf(self: unknown): string | null {
  const value = text(self);
  const id = value?.match(/\/webhook\/([^/]+)\/?$/)?.[1];
  return id ? decodeURIComponent(id) : null;
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

  private async storedWebhookSettings() {
    return readConnectionSettings(
      this.credentials,
      CREDENTIALS.jiraWebhookSettings,
      jiraWebhookConnectionSettings,
    );
  }

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
    const [settings, connection, secretConfigured, latest] = await Promise.all([
      prisma.jiraSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID },
        update: {},
      }),
      this.storedWebhookSettings(),
      this.credentials.isConfigured(CREDENTIALS.jiraWebhookSecret),
      prisma.jiraWebhookDelivery.findFirst({
        orderBy: [{ receivedAt: "desc" }, { deliveryId: "desc" }],
      }),
    ]);
    return {
      enabled: settings.webhookEnabled && secretConfigured,
      secretConfigured,
      registered: Boolean(settings.webhookId),
      registrationId: settings.webhookId ?? null,
      registeredUrl: connection?.value.url ?? null,
      jql: connection?.value.jql ?? null,
      configuredAt: settings.webhookConfiguredAt?.toISOString() ?? null,
      lastReceivedAt: latest?.receivedAt.toISOString() ?? null,
      lastOutcome: latest?.outcome ?? null,
      lastError: latest?.error ?? null,
    };
  }

  /**
   * Mints the shared secret without touching Jira, for sites where the API
   * token's user is not a Jira admin: the user pastes the secret, and the URL,
   * into Jira's admin UI themselves. The plaintext secret is returned exactly
   * once and never stored in readable form.
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

  /**
   * Creates the webhook in Jira and stores the matching secret, so the user
   * never has to open Jira's admin UI. Registering again reuses the stored
   * webhook, which is how the URL and the JQL filter get edited later.
   *
   * Jira is written first: a failure there leaves the previous configuration
   * untouched rather than storing a secret Jira does not know about.
   */
  async registerWebhook(
    input: JiraWebhookRegistrationInput,
  ): Promise<JiraWebhookSecretView> {
    const url = normalizeJiraDeliveryUrl(input.url);
    const jql = input.jql?.trim() || null;
    const secret = randomBytes(32).toString("base64url");
    const prisma = await getPrismaClient();
    const existing = await prisma.jiraSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { webhookId: true },
    });

    const webhookId = await this.writeToJira({
      webhookId: existing?.webhookId ?? null,
      url,
      jql,
      secret,
    });

    const connection: JiraWebhookConnectionSettings = { url, jql };
    await this.credentials.setMany(
      [
        {
          descriptor: CREDENTIALS.jiraWebhookSettings,
          value: encodeJsonCredential(connection),
        },
        {
          descriptor: CREDENTIALS.jiraWebhookSecret,
          value: Buffer.from(secret, "utf8"),
        },
      ],
      async (transaction) => {
        await transaction.jiraSettings.upsert({
          where: { id: SETTINGS_ID },
          create: {
            id: SETTINGS_ID,
            webhookEnabled: true,
            webhookConfiguredAt: new Date(),
            webhookId,
          },
          update: {
            webhookEnabled: true,
            webhookConfiguredAt: new Date(),
            webhookId,
          },
        });
      },
    );
    return { settings: await this.getWebhookSettings(), secret };
  }

  async rotateSecret(): Promise<JiraWebhookSecretView> {
    if (!(await this.credentials.isConfigured(CREDENTIALS.jiraWebhookSecret))) {
      throw new Error("The Jira webhook is not configured");
    }
    const [settings, connection] = await Promise.all([
      (await getPrismaClient()).jiraSettings.findUnique({
        where: { id: SETTINGS_ID },
        select: { webhookId: true },
      }),
      this.storedWebhookSettings(),
    ]);
    // A registered webhook rotates on both sides at once; a hand-made one can
    // only mint a new secret and wait for the user to paste it into Jira.
    if (settings?.webhookId && connection) {
      return this.registerWebhook({
        url: connection.value.url,
        jql: connection.value.jql,
      });
    }
    return this.enableWebhook();
  }

  async disableWebhook(): Promise<JiraWebhookSettingsView> {
    const prisma = await getPrismaClient();
    const settings = await prisma.jiraSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { webhookId: true },
    });
    if (settings?.webhookId) {
      await this.deleteFromJira(settings.webhookId);
    }
    await this.credentials.deleteMany(
      [CREDENTIALS.jiraWebhookSettings, CREDENTIALS.jiraWebhookSecret],
      async (transaction) => {
        await transaction.jiraSettings.upsert({
          where: { id: SETTINGS_ID },
          create: { id: SETTINGS_ID },
          update: {
            webhookEnabled: false,
            webhookConfiguredAt: null,
            webhookId: null,
          },
        });
      },
    );
    return this.getWebhookSettings();
  }

  /**
   * Creates or updates the webhook in Jira and returns its ID. A stored ID that
   * Jira no longer knows — someone deleted the webhook by hand — falls back to
   * creating a fresh one instead of failing the whole operation.
   */
  private async writeToJira(input: {
    webhookId: string | null;
    url: string;
    jql: string | null;
    secret: string;
  }): Promise<string> {
    const body = {
      name: WEBHOOK_NAME,
      description: WEBHOOK_DESCRIPTION,
      url: input.url,
      events: [...RECOMMENDED_JIRA_WEBHOOK_EVENTS],
      // The delivery handler reads the payload, so Jira has to send one.
      excludeBody: false,
      // Omitting `secret` on a PUT keeps the old one, so rotation always sends it.
      secret: input.secret,
      ...(input.jql
        ? { filters: { "issue-related-events-section": input.jql } }
        : {}),
    };

    if (input.webhookId) {
      const path = `${WEBHOOK_API_PATH}/${encodeURIComponent(input.webhookId)}`;
      try {
        await this.jira.webhookApiRequest("PUT", path, body);
        return input.webhookId;
      } catch (error) {
        if (statusOf(error) !== 404) throw error;
      }
    }

    const created = await this.jira.webhookApiRequest<{ self?: string }>(
      "POST",
      WEBHOOK_API_PATH,
      body,
    );
    const webhookId = webhookIdOf(created?.self);
    if (!webhookId) {
      throw new Error("Jira did not return the ID of the new webhook");
    }
    return webhookId;
  }

  /** Removes the webhook from Jira, treating an already-gone one as success. */
  private async deleteFromJira(webhookId: string): Promise<void> {
    try {
      await this.jira.webhookApiRequest(
        "DELETE",
        `${WEBHOOK_API_PATH}/${encodeURIComponent(webhookId)}`,
      );
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
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
    if (!secret) {
      throw new JiraWebhookRequestError("Jira webhook is not configured", 503);
    }
    if (!input.signature?.startsWith("sha256=")) {
      throw new JiraWebhookRequestError(
        "Jira webhook signature is missing",
        401,
      );
    }
    const expected = `sha256=${createHmac("sha256", secret)
      .update(input.body)
      .digest("hex")}`;
    if (!secureEqual(expected, input.signature)) {
      throw new JiraWebhookRequestError(
        "Jira webhook signature is invalid",
        401,
      );
    }
    if (!input.deliveryId?.trim()) {
      throw new JiraWebhookRequestError("Jira delivery ID is missing", 400);
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
          changelogJson: null,
          retryCount: retries,
          outcome: "RECEIVED",
          error: null,
          receivedAt: new Date(),
          processedAt: null,
        },
      });
      if (retried.count === 0) {
        await this.prune().catch(() => undefined);
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
        const parsed = JSON.parse(Buffer.from(input.body).toString("utf8"));
        const object = record(parsed);
        if (!object) throw new Error("Payload is not an object");
        payload = object;
      } catch {
        throw new JiraWebhookRequestError(
          "Jira webhook payload is invalid JSON",
          400,
        );
      }
      const event = text(payload.webhookEvent);
      let issueKey = issueKeyOf(payload);
      let projectKey = projectKeyOf(payload);
      const changelog = normalizeChangelog(payload.changelog);
      await prisma.jiraWebhookDelivery.update({
        where: { deliveryId },
        data: {
          event: event ?? "unknown",
          issueKey,
          projectKey,
          changelogJson: changelog ? JSON.stringify(changelog) : null,
        },
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

      let issueKeys = issueKey ? [issueKey] : [];
      if (event === "issuelink_created" || event === "issuelink_deleted") {
        const issueIds = issueLinkIssueIds(payload);
        if (issueIds.length === 0) {
          await finish("IGNORED", "Payload has no issue-link issue IDs");
          return { outcome: "IGNORED", event, issueKey, triggersRecorded: 0 };
        }
        issueKeys = await this.jira.resolveIssueKeys(issueIds);
        issueKey = issueKeys[0] ?? null;
        projectKey = issueKey
          ? (projectKey ?? projectKeyFromIssueKey(issueKey))
          : projectKey;
        await prisma.jiraWebhookDelivery.update({
          where: { deliveryId },
          data: { issueKey, projectKey },
        });
      }

      const sprintEvent =
        event === "sprint_started" || event === "sprint_closed";
      if (!sprintEvent && !issueKey) {
        await finish("IGNORED", "Payload has no issue key");
        return { outcome: "IGNORED", event, issueKey, triggersRecorded: 0 };
      }

      // Refreshing the ticket both repopulates the cache the Jira pages read
      // and makes JiraService emit the existing cursor-based JIRA_* triggers.
      const changedTickets: Array<{
        key: string;
        projectKey: string | null;
      }> = [];
      if (event === "jira:issue_deleted") {
        await this.jira.deleteCachedTicket(issueKey!);
        changedTickets.push({ key: issueKey!, projectKey });
      } else if (sprintEvent) {
        const sprintId = sprintIdOf(payload);
        if (!sprintId) {
          await finish("IGNORED", "Payload has no valid sprint ID");
          return { outcome: "IGNORED", event, issueKey, triggersRecorded: 0 };
        }
        const tickets = await this.jira.refreshSprintTickets(sprintId);
        changedTickets.push(
          ...tickets.map((ticket) => ({
            key: ticket.key,
            projectKey: ticket.projectKey,
          })),
        );
      } else if (event === "jira:issue_updated") {
        const ticket = await this.jira.refreshCachedTicket(
          issueKey!,
          changelog,
        );
        changedTickets.push({ key: ticket.key, projectKey: ticket.projectKey });
      } else if (ISSUE_MUTATING_EVENTS.has(event)) {
        const tickets = await Promise.all(
          issueKeys.map((key) => this.jira.refreshCachedTicket(key)),
        );
        changedTickets.push(
          ...tickets.map((ticket) => ({
            key: ticket.key,
            projectKey: ticket.projectKey,
          })),
        );
      }

      const triggersRecorded = issueKey
        ? await this.recordWebhookTrigger({
            event,
            deliveryId,
            issueKey,
            projectKey,
            retries,
            payload,
          })
        : 0;

      for (const ticket of changedTickets) {
        agentEventBus.publish(JIRA_TICKET_CHANGED_TOPIC, {
          jiraTicketChanged: {
            issueKey: ticket.key,
            projectKey: ticket.projectKey,
            event,
          } satisfies JiraTicketChange,
        });
      }

      await finish("PROCESSED");
      return { outcome: "PROCESSED", event, issueKey, triggersRecorded };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finish("ERROR", message);
      throw error;
    } finally {
      await this.prune().catch(() => undefined);
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
    const changelog = normalizeChangelog(payload.changelog);

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
      changelog,
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
  changelogJson: string | null;
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
    changelog: storedChangelog(delivery.changelogJson),
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
