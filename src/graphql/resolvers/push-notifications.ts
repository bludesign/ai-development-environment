import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { PushNotificationsService } from "@/services/push-notifications";
import { validatePushEditor } from "@/services/push-notifications";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error("Agent credentials cannot manage push notifications");
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

const dateFields = {
  createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
};

export const createPushNotificationsResolvers = (
  service: PushNotificationsService,
) => ({
  ApnsRegistration: {
    ...dateFields,
    tokenMasked: (value: { tokenMasked?: string; token?: string }) =>
      value.tokenMasked ??
      (value.token
        ? `${value.token.slice(0, 8)}…${value.token.slice(-8)}`
        : "—"),
    supportedPushTypes: (value: {
      supportedPushTypes?: string[];
      pushTypesJson?: string;
    }) =>
      value.supportedPushTypes ??
      (value.pushTypesJson ? JSON.parse(value.pushTypesJson) : []),
    pushMagicConfigured: (value: { pushMagic: string | null }) =>
      Boolean(value.pushMagic),
    invalidatedAt: (value: { invalidatedAt: Date | null }) =>
      iso(value.invalidatedAt),
    lastFailureAt: (value: { lastFailureAt: Date | null }) =>
      iso(value.lastFailureAt),
    lastRegisteredAt: (value: { lastRegisteredAt: Date }) =>
      value.lastRegisteredAt.toISOString(),
    lastSentAt: (value: { lastSentAt: Date | null }) => iso(value.lastSentAt),
  },
  ApnsCertificateCredential: {
    ...dateFields,
    expiresAt: (value: { expiresAt: Date | null }) => iso(value.expiresAt),
    lastTestedAt: (value: { lastTestedAt: Date | null }) =>
      iso(value.lastTestedAt),
  },
  PushNotificationSettings: {
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
    tokenConfiguredAt: (value: { tokenConfiguredAt: Date | null }) =>
      iso(value.tokenConfiguredAt),
    tokenLastUsedAt: (value: { tokenLastUsedAt: Date | null }) =>
      iso(value.tokenLastUsedAt),
  },
  ApnsBroadcastChannel: dateFields,
  PushNotificationPreset: {
    ...dateFields,
    editor: (value: { editorJson: string }) => JSON.parse(value.editorJson),
  },
  PushNotificationBatch: {
    ...dateFields,
    editor: (value: { editorJson: string }) => JSON.parse(value.editorJson),
    payload: (value: { payloadJson: string }) => JSON.parse(value.payloadJson),
    headers: (value: { headersJson: string }) => JSON.parse(value.headersJson),
    startedAt: (value: { startedAt: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
  },
  PushNotificationDelivery: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    startedAt: (value: { startedAt: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
    responseTimestamp: (value: { responseTimestamp: Date | null }) =>
      iso(value.responseTimestamp),
  },
  Query: {
    apnsRegistrations: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.registrations();
    },
    pushNotificationSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.settings();
    },
    apnsBroadcastChannels: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.channels();
    },
    pushNotificationPresets: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.presets();
    },
    pushNotificationHistory: (
      _root: unknown,
      { limit }: { limit?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.history(limit);
    },
    validatePushNotification: (
      _root: unknown,
      { editor }: { editor: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return validatePushEditor(editor);
    },
  },
  Mutation: {
    renameApnsRegistration: (
      _root: unknown,
      args: { id: string; displayName: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.renameRegistration(args.id, args.displayName);
    },
    setApnsRegistrationActive: (
      _root: unknown,
      args: { id: string; active: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.setRegistrationActive(args.id, args.active);
    },
    deleteApnsRegistration: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteRegistration(id);
    },
    saveApnsTokenSettings: (
      _root: unknown,
      {
        input,
      }: {
        input: Parameters<PushNotificationsService["saveTokenSettings"]>[0];
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveTokenSettings(input);
    },
    clearApnsTokenSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearTokenSettings();
    },
    addApnsCertificateCredential: (
      _root: unknown,
      {
        input,
      }: {
        input: Parameters<
          PushNotificationsService["addCertificateCredential"]
        >[0];
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.addCertificateCredential(input);
    },
    retestApnsCertificateCredential: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.retestCertificateCredential(id);
    },
    deleteApnsCertificateCredential: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteCertificateCredential(id);
    },
    createApnsBroadcastChannel: (
      _root: unknown,
      {
        input,
      }: { input: Parameters<PushNotificationsService["createChannel"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createChannel(input);
    },
    deleteApnsBroadcastChannel: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteChannel(id);
    },
    savePushNotificationPreset: (
      _root: unknown,
      args: { id?: string | null; name: string; editor: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.savePreset(args.name, args.editor, args.id);
    },
    deletePushNotificationPreset: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deletePreset(id);
    },
    savePushNotificationDraft: (
      _root: unknown,
      { editor }: { editor: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveDraft(editor);
    },
    sendPushNotification: (
      _root: unknown,
      { input }: { input: Parameters<PushNotificationsService["send"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.send(input);
    },
    resendPushNotification: (
      _root: unknown,
      args: { id: string; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.resend(args.id, args.requestId);
    },
    deletePushNotificationHistory: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteHistory(id);
    },
    clearPushNotificationHistory: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearHistory();
    },
  },
  Subscription: {
    pushNotificationsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
      resolve: () => true,
    },
  },
});
