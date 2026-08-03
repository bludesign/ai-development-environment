export const APP_NOTIFICATION_FIELDS = `
  id typeKey title body href resourceKind resourceId worktreeId highlightColor
  sidebarRequested browserRequested webPushRequested apnsRequested
  sidebarDismissedAt createdAt updatedAt
`;

export const NOTIFICATION_DEVICE_FIELDS = `
  id clientRegistrationId tokenMasked topic environment displayName deviceModel osVersion
  appVersion appBuild locale status lastFailureReason lastFailureAt lastRegisteredAt
  lastDeliveredAt createdAt updatedAt
`;

export type AppNotificationView = {
  id: string;
  typeKey: string;
  title: string;
  body: string;
  href: string;
  resourceKind: string;
  resourceId: string;
  worktreeId: string | null;
  highlightColor: string | null;
  sidebarRequested: boolean;
  browserRequested: boolean;
  webPushRequested: boolean;
  apnsRequested: boolean;
  sidebarDismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationPreferenceView = {
  key: string;
  category: string;
  label: string;
  description: string;
  sidebarEnabled: boolean;
  browserEnabled: boolean;
  webPushEnabled: boolean;
  apnsEnabled: boolean;
  updatedAt: string | null;
};

export type NotificationChangeView = {
  kind:
    | "CREATED"
    | "DISMISSED"
    | "SIDEBAR_CLEARED"
    | "DELETED"
    | "HISTORY_CLEARED"
    | "PREFERENCES_UPDATED"
    | "DEVICES_CHANGED";
  notification: AppNotificationView | null;
  notificationId: string | null;
};

export type NotificationApnsStateView = {
  configured: boolean;
  deviceCount: number;
};

export type NotificationDeviceView = {
  id: string;
  clientRegistrationId: string;
  tokenMasked: string;
  topic: string;
  environment: string;
  displayName: string;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  locale: string | null;
  status: string;
  lastFailureReason: string | null;
  lastFailureAt: string | null;
  lastRegisteredAt: string;
  lastDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebPushStateView = {
  configured: boolean;
  publicKey: string | null;
  subscriptionCount: number;
};

export type WebPushSubscriptionView = {
  id: string;
  endpoint: string;
  expirationTime: string | null;
  locale: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};
