export const APP_NOTIFICATION_FIELDS = `
  id typeKey title body href resourceKind resourceId worktreeId highlightColor
  sidebarRequested browserRequested webPushRequested sidebarDismissedAt createdAt updatedAt
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
  updatedAt: string | null;
};

export type NotificationChangeView = {
  kind:
    | "CREATED"
    | "DISMISSED"
    | "SIDEBAR_CLEARED"
    | "DELETED"
    | "HISTORY_CLEARED"
    | "PREFERENCES_UPDATED";
  notification: AppNotificationView | null;
  notificationId: string | null;
};

export type WebPushStateView = {
  configured: boolean;
  publicKey: string | null;
  subscriptionCount: number;
};
