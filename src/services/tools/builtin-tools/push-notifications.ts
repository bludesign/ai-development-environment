import * as z from "zod/v4";

import type { PushNotificationsService } from "@/services/push-notifications";
import { validatePushEditor } from "@/services/push-notifications";

import {
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const RegistrationSchema = z.object({
  id: z.string(),
  clientRegistrationId: z.string(),
  tokenMasked: z.string(),
  topic: z.string(),
  environment: z.string(),
  supportedPushTypes: z.array(z.string()),
  displayName: z.string(),
  deviceModel: z.string().nullable(),
  osVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  appBuild: z.string().nullable(),
  locale: z.string().nullable(),
  pushMagicConfigured: z.boolean(),
  status: z.string(),
  invalidatedAt: z.string().nullable(),
  lastFailureReason: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  lastRegisteredAt: z.string(),
  lastSentAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const CertificateSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string(),
  environment: z.string(),
  fingerprint: z.string(),
  expiresAt: z.string().nullable(),
  lastTestedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const SettingsSchema = z.object({
  tokenConfigured: z.boolean(),
  tokenTeamId: z.string().nullable(),
  tokenKeyId: z.string().nullable(),
  tokenPrivateKeyFingerprint: z.string().nullable(),
  tokenConfiguredAt: z.string().nullable(),
  tokenLastUsedAt: z.string().nullable(),
  tokenLastError: z.string().nullable(),
  certificates: z.array(CertificateSchema),
  updatedAt: z.string(),
});
const ChannelSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  bundleId: z.string(),
  environment: z.string(),
  storagePolicy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const PresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  editor: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const DeliverySchema = z.object({
  id: z.string(),
  registrationId: z.string().nullable(),
  topic: z.string(),
  environment: z.string(),
  status: z.string(),
  apnsId: z.string().nullable(),
  responseCode: z.number().int().nullable(),
  reason: z.string().nullable(),
  responseTimestamp: z.string().nullable(),
  attempts: z.number().int(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
const BatchSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  status: z.string(),
  editor: z.unknown(),
  payload: z.unknown(),
  headers: z.unknown(),
  targetMode: z.string(),
  channelId: z.string().nullable(),
  recipientCount: z.number().int(),
  successCount: z.number().int(),
  failureCount: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
  deliveries: z.array(DeliverySchema),
});

function registrationView(value: Record<string, unknown>) {
  const pushTypes = Array.isArray(value.supportedPushTypes)
    ? value.supportedPushTypes
    : parseJson(value.pushTypesJson);
  const token = typeof value.token === "string" ? value.token : "";
  return {
    id: String(value.id),
    clientRegistrationId: String(value.clientRegistrationId),
    tokenMasked:
      typeof value.tokenMasked === "string"
        ? value.tokenMasked
        : token
          ? `${token.slice(0, 8)}…${token.slice(-8)}`
          : "—",
    topic: String(value.topic),
    environment: String(value.environment),
    supportedPushTypes: Array.isArray(pushTypes) ? pushTypes : [],
    displayName: String(value.displayName),
    deviceModel:
      typeof value.deviceModel === "string" ? value.deviceModel : null,
    osVersion: typeof value.osVersion === "string" ? value.osVersion : null,
    appVersion: typeof value.appVersion === "string" ? value.appVersion : null,
    appBuild: typeof value.appBuild === "string" ? value.appBuild : null,
    locale: typeof value.locale === "string" ? value.locale : null,
    pushMagicConfigured: Boolean(value.pushMagic),
    status: String(value.status),
    invalidatedAt: iso(value.invalidatedAt),
    lastFailureReason:
      typeof value.lastFailureReason === "string"
        ? value.lastFailureReason
        : null,
    lastFailureAt: iso(value.lastFailureAt),
    lastRegisteredAt: iso(value.lastRegisteredAt),
    lastSentAt: iso(value.lastSentAt),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

function certificateView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    name: String(value.name),
    topic: String(value.topic),
    environment: String(value.environment),
    fingerprint: String(value.fingerprint),
    expiresAt: iso(value.expiresAt),
    lastTestedAt: iso(value.lastTestedAt),
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

function settingsView(value: Record<string, unknown>) {
  return {
    tokenConfigured: Boolean(value.tokenConfigured),
    tokenTeamId:
      typeof value.tokenTeamId === "string" ? value.tokenTeamId : null,
    tokenKeyId: typeof value.tokenKeyId === "string" ? value.tokenKeyId : null,
    tokenPrivateKeyFingerprint:
      typeof value.tokenPrivateKeyFingerprint === "string"
        ? value.tokenPrivateKeyFingerprint
        : null,
    tokenConfiguredAt: iso(value.tokenConfiguredAt),
    tokenLastUsedAt: iso(value.tokenLastUsedAt),
    tokenLastError:
      typeof value.tokenLastError === "string" ? value.tokenLastError : null,
    certificates: Array.isArray(value.certificates)
      ? value.certificates.map((item) =>
          certificateView(item as Record<string, unknown>),
        )
      : [],
    updatedAt: iso(value.updatedAt),
  };
}

function channelView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    channelId: String(value.channelId),
    bundleId: String(value.bundleId),
    environment: String(value.environment),
    storagePolicy: String(value.storagePolicy),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

function presetView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    name: String(value.name),
    editor: parseJson(value.editor ?? value.editorJson),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

function deliveryView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    registrationId:
      typeof value.registrationId === "string" ? value.registrationId : null,
    topic: String(value.topic),
    environment: String(value.environment),
    status: String(value.status),
    apnsId: typeof value.apnsId === "string" ? value.apnsId : null,
    responseCode:
      typeof value.responseCode === "number" ? value.responseCode : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    responseTimestamp: iso(value.responseTimestamp),
    attempts: Number(value.attempts),
    durationMs: typeof value.durationMs === "number" ? value.durationMs : null,
    createdAt: iso(value.createdAt),
    startedAt: iso(value.startedAt),
    finishedAt: iso(value.finishedAt),
  };
}

function batchView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    requestId: String(value.requestId),
    status: String(value.status),
    editor: parseJson(value.editor ?? value.editorJson),
    payload: parseJson(value.payload ?? value.payloadJson),
    headers: parseJson(value.headers ?? value.headersJson),
    targetMode: String(value.targetMode),
    channelId: typeof value.channelId === "string" ? value.channelId : null,
    recipientCount: Number(value.recipientCount),
    successCount: Number(value.successCount),
    failureCount: Number(value.failureCount),
    error: typeof value.error === "string" ? value.error : null,
    createdAt: iso(value.createdAt),
    startedAt: iso(value.startedAt),
    finishedAt: iso(value.finishedAt),
    updatedAt: iso(value.updatedAt),
    deliveries: Array.isArray(value.deliveries)
      ? value.deliveries.map((item) =>
          deliveryView(item as Record<string, unknown>),
        )
      : [],
  };
}

const TargetSchema = z.discriminatedUnion("targetMode", [
  z.object({
    targetMode: z.literal("DEVICES"),
    registrationIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({ targetMode: z.literal("ALL") }),
  z.object({
    targetMode: z.literal("BROADCAST"),
    channelId: z.string().min(1),
  }),
  z.object({
    targetMode: z.literal("DIRECT"),
    directToken: z.string().min(1),
    directTokenEncoding: z.enum(["HEX", "BASE64"]).default("HEX"),
    directEnvironment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
  }),
]);
const SendInputSchema = z.intersection(
  z.object({
    requestId: z.string().min(1),
    editor: z.record(z.string(), z.unknown()),
  }),
  TargetSchema,
);
const SendPresetInputSchema = z.intersection(
  z.object({
    requestId: z.string().min(1),
    presetId: z.string().min(1),
  }),
  TargetSchema,
);

function sendArguments(
  input: z.output<typeof SendInputSchema>,
): Parameters<PushNotificationsService["send"]>[0] {
  return {
    requestId: input.requestId,
    editor: input.editor,
    targetMode: input.targetMode,
    registrationIds:
      input.targetMode === "DEVICES" ? input.registrationIds : undefined,
    channelId: input.targetMode === "BROADCAST" ? input.channelId : undefined,
    directToken: input.targetMode === "DIRECT" ? input.directToken : undefined,
    directTokenEncoding:
      input.targetMode === "DIRECT" ? input.directTokenEncoding : undefined,
    directEnvironment:
      input.targetMode === "DIRECT" ? input.directEnvironment : undefined,
  };
}

export function createPushNotificationToolGroup(
  push: PushNotificationsService,
): BuiltInToolGroup {
  const sendAnnotations = { ...WRITE_ANNOTATIONS, openWorldHint: true };
  return {
    id: "builtin:debugging:push-notifications",
    name: "Push Notifications",
    children: [],
    tools: [
      defineTool({
        name: "get_push_notification_registrations",
        title: "Get push notification registrations",
        description: "List registered APNs devices with masked tokens.",
        inputSchema: z.object({}),
        outputSchema: z.object({ registrations: z.array(RegistrationSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({
          registrations: (await push.registrations()).map((item) =>
            registrationView(item as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "get_push_notification_settings",
        title: "Get push notification settings",
        description:
          "Inspect APNs credential status without returning secrets.",
        inputSchema: z.object({}),
        outputSchema: z.object({ settings: SettingsSchema }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({
          settings: settingsView(
            (await push.settings()) as unknown as Record<string, unknown>,
          ),
        }),
      }),
      defineTool({
        name: "get_push_notification_channels",
        title: "Get push notification channels",
        description: "List configured APNs broadcast channels.",
        inputSchema: z.object({}),
        outputSchema: z.object({ channels: z.array(ChannelSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({
          channels: (await push.channels()).map((item) =>
            channelView(item as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "get_push_notification_presets",
        title: "Get push notification presets",
        description: "List saved, validated push editor presets.",
        inputSchema: z.object({}),
        outputSchema: z.object({ presets: z.array(PresetSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({
          presets: (await push.presets()).map((item) =>
            presetView(item as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "get_push_notification_history",
        title: "Get push notification history",
        description:
          "List recent push batches and per-recipient delivery results.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(200).default(100),
        }),
        outputSchema: z.object({ batches: z.array(BatchSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ limit }) => ({
          batches: (await push.history(limit)).map((item) =>
            batchView(item as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "get_push_notification_history_item",
        title: "Get push notification history item",
        description: "Get one push batch and all delivery results by ID.",
        inputSchema: z.object({ id: z.string().min(1) }),
        outputSchema: z.object({ batch: BatchSchema.nullable() }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ id }) => {
          const item = await push.historyItem(id);
          return {
            batch: item
              ? batchView(item as unknown as Record<string, unknown>)
              : null,
          };
        },
      }),
      defineTool({
        name: "preview_push_notification",
        title: "Preview push notification",
        description:
          "Validate an editor and return its final payload and APNs headers.",
        inputSchema: z.object({
          editor: z.record(z.string(), z.unknown()),
        }),
        outputSchema: z.object({
          editor: z.unknown(),
          payload: z.unknown(),
          headers: z.record(z.string(), z.string()),
          byteLength: z.number().int().nonnegative(),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: ({ editor }) => validatePushEditor(editor),
      }),
      defineTool({
        name: "send_push_notification",
        title: "Send push notification",
        description:
          "Validate and queue a raw APNs editor payload for delivery.",
        inputSchema: SendInputSchema,
        outputSchema: z.object({ batch: BatchSchema }),
        annotations: sendAnnotations,
        handler: async (input) => ({
          batch: batchView(
            (await push.send(sendArguments(input))) as unknown as Record<
              string,
              unknown
            >,
          ),
        }),
      }),
      defineTool({
        name: "send_push_notification_preset",
        title: "Send push notification preset",
        description:
          "Load a saved preset by ID and queue it for APNs delivery.",
        inputSchema: SendPresetInputSchema,
        outputSchema: z.object({ batch: BatchSchema }),
        annotations: sendAnnotations,
        handler: async (input) => {
          const preset = await push.preset(input.presetId);
          if (!preset) throw new Error("Push notification preset not found");
          const raw = {
            ...input,
            editor: parseJson(preset.editorJson) as Record<string, unknown>,
          } as z.output<typeof SendInputSchema>;
          return {
            batch: batchView(
              (await push.send(sendArguments(raw))) as unknown as Record<
                string,
                unknown
              >,
            ),
          };
        },
      }),
      defineTool({
        name: "resend_push_notification",
        title: "Resend push notification",
        description: "Queue a historical non-draft, non-direct batch again.",
        inputSchema: z.object({
          id: z.string().min(1),
          requestId: z.string().min(1),
        }),
        outputSchema: z.object({ batch: BatchSchema }),
        annotations: sendAnnotations,
        handler: async ({ id, requestId }) => ({
          batch: batchView(
            (await push.resend(id, requestId)) as unknown as Record<
              string,
              unknown
            >,
          ),
        }),
      }),
    ],
  };
}
