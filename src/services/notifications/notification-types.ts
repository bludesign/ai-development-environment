export const NOTIFICATION_TYPES = {
  IOS_BUILD_SUCCEEDED: {
    key: "IOS_BUILD_SUCCEEDED",
    category: "BUILDS",
    label: "iOS build succeeded",
    description: "An iOS build finishes successfully.",
    defaultSidebarEnabled: true,
    defaultBrowserEnabled: true,
    defaultWebPushEnabled: false,
  },
  IOS_BUILD_FAILED: {
    key: "IOS_BUILD_FAILED",
    category: "BUILDS",
    label: "iOS build failed",
    description: "An iOS build finishes with a failure.",
    defaultSidebarEnabled: true,
    defaultBrowserEnabled: true,
    defaultWebPushEnabled: false,
  },
  GITHUB_ACTIONS_SUCCEEDED: {
    key: "GITHUB_ACTIONS_SUCCEEDED",
    category: "GITHUB",
    label: "GitHub Actions succeeded",
    description: "A GitHub Actions workflow finishes successfully.",
    defaultSidebarEnabled: true,
    defaultBrowserEnabled: true,
    defaultWebPushEnabled: false,
  },
  GITHUB_ACTIONS_FAILED: {
    key: "GITHUB_ACTIONS_FAILED",
    category: "GITHUB",
    label: "GitHub Actions failed",
    description: "A GitHub Actions workflow finishes with a failure.",
    defaultSidebarEnabled: true,
    defaultBrowserEnabled: true,
    defaultWebPushEnabled: false,
  },
} as const;

export type NotificationTypeKey = keyof typeof NOTIFICATION_TYPES;
export type NotificationTypeDefinition =
  (typeof NOTIFICATION_TYPES)[NotificationTypeKey];

export function notificationType(
  value: string,
): NotificationTypeDefinition | null {
  return value in NOTIFICATION_TYPES
    ? NOTIFICATION_TYPES[value as NotificationTypeKey]
    : null;
}

export function notificationTypeDefinitions(): NotificationTypeDefinition[] {
  return Object.values(NOTIFICATION_TYPES);
}
