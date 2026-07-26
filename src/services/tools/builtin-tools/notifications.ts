import * as z from "zod/v4";

import type { NotificationsService } from "@/services/notifications";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createNotificationToolGroup(
  service: NotificationsService,
): BuiltInToolGroup {
  return {
    id: "builtin:notifications",
    name: "Notifications",
    children: [],
    tools: [
      serviceTool({
        name: "get_notification_history",
        title: "Get notification history",
        description: "Get paginated application notification history.",
        inputSchema: z.object({
          first: z.number().int().min(1).max(500).default(100),
          after: z.string().nullable().optional(),
        }),
        service,
        method: "history",
        resultKey: "page",
      }),
      serviceTool({
        name: "get_notification_preferences",
        title: "Get notification preferences",
        description: "Get notification-category preferences.",
        inputSchema: z.object({}),
        service,
        method: "preferences",
        arguments: () => [],
        resultKey: "preferences",
      }),
      serviceTool({
        name: "get_notification_sidebar",
        title: "Get notification sidebar",
        description: "Get unread and recent notification sidebar state.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(200).default(25),
        }),
        service,
        method: "sidebar",
        arguments: ({ limit }) => [limit],
        resultKey: "sidebar",
      }),
      serviceTool({
        name: "get_web_push_status",
        title: "Get web-push status",
        description: "Get redacted web-push readiness and subscription status.",
        inputSchema: z.object({}),
        service,
        method: "webPushState",
        arguments: () => [],
        resultKey: "status",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_notification_preference",
        title: "Update notification preference",
        description: "Update one notification-category preference.",
        inputSchema: z.object({
          input: z.object({
            typeKey: z.string().min(1),
            sidebarEnabled: z.boolean(),
            browserEnabled: z.boolean(),
            webPushEnabled: z.boolean(),
          }),
        }),
        service,
        method: "savePreference",
        arguments: ({ input }) => [input],
        resultKey: "preference",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "dismiss_notification",
        title: "Dismiss notification",
        description: "Dismiss one application notification.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "dismiss",
        arguments: ({ id }) => [id],
        resultKey: "dismissed",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "dismiss_all_notifications",
        title: "Dismiss all notifications",
        description: "Dismiss every current application notification.",
        inputSchema: z.object({}),
        service,
        method: "dismissAll",
        arguments: () => [],
        resultKey: "count",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_notifications",
        title: "Delete notifications",
        description:
          "Permanently delete notifications selected by IDs or filters.",
        inputSchema: z.object({
          selection: z.object({
            all: z.boolean().nullable().optional(),
            ids: z.array(z.string().min(1)).nullable().optional(),
            excludedIds: z.array(z.string().min(1)).nullable().optional(),
            ranges: z
              .array(
                z.object({ start: z.iso.datetime(), end: z.iso.datetime() }),
              )
              .nullable()
              .optional(),
            excludedRanges: z
              .array(
                z.object({ start: z.iso.datetime(), end: z.iso.datetime() }),
              )
              .nullable()
              .optional(),
          }),
        }),
        service,
        method: "deleteSelection",
        arguments: ({ selection }) => [selection],
        resultKey: "count",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "test_web_push_subscription",
        title: "Test web-push subscription",
        description:
          "Send a test notification to a saved web-push subscription.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "testWebPushSubscription",
        arguments: ({ id }) => [id],
        resultKey: "sent",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
    ],
  };
}
