import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  NotificationSelection,
  NotificationsService,
  RegisterWebPushSubscriptionInput,
} from "@/services/notifications";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error("Agent credentials cannot manage notifications");
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export const createNotificationsResolvers = (
  service: NotificationsService,
) => ({
  AppNotification: {
    sidebarDismissedAt: (value: { sidebarDismissedAt: Date | null }) =>
      iso(value.sidebarDismissedAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  NotificationPreference: {
    updatedAt: (value: { updatedAt: Date | null }) => iso(value.updatedAt),
  },
  WebPushSubscription: {
    expirationTime: (value: { expirationTime: Date | null }) =>
      iso(value.expirationTime),
    lastSeenAt: (value: { lastSeenAt: Date }) => value.lastSeenAt.toISOString(),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  Query: {
    notifications: (
      _root: unknown,
      args: { first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.history(args);
    },
    sidebarNotifications: (
      _root: unknown,
      { limit }: { limit?: number | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.sidebar(limit ?? undefined);
    },
    notificationPreferences: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.preferences();
    },
    webPushState: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.webPushState();
    },
    webPushSubscriptions: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.webPushSubscriptions();
    },
  },
  Mutation: {
    saveNotificationPreference: (
      _root: unknown,
      {
        input,
      }: { input: Parameters<NotificationsService["savePreference"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.savePreference(input);
    },
    dismissNotification: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.dismiss(id);
    },
    dismissAllSidebarNotifications: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.dismissAll();
    },
    deleteNotifications: (
      _root: unknown,
      { selection }: { selection: NotificationSelection },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteSelection(selection);
    },
    deleteAllNotifications: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteAll();
    },
    prepareWebPush: async (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      await service.prepareWebPush();
      return service.webPushState();
    },
    registerWebPushSubscription: async (
      _root: unknown,
      { input }: { input: RegisterWebPushSubscriptionInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      await service.registerWebPush(input);
      return service.webPushState();
    },
    unregisterWebPushSubscription: (
      _root: unknown,
      { endpoint }: { endpoint: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.unregisterWebPush(endpoint);
    },
    deleteWebPushSubscription: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteWebPushSubscription(id);
    },
    testWebPushSubscription: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.testWebPushSubscription(id);
    },
  },
  Subscription: {
    notificationsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
    },
  },
});
