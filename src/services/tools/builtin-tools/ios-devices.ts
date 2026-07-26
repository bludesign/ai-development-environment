import * as z from "zod/v4";

import type { IosDevicesService } from "@/services/ios-devices";

import {
  DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createIosDeviceToolGroup(
  service: IosDevicesService,
): BuiltInToolGroup {
  return {
    id: "builtin:ios-devices",
    name: "iOS Devices",
    children: [],
    tools: [
      serviceTool({
        name: "get_ios_devices",
        title: "Get iOS devices",
        description: "List enrolled and pending iOS devices.",
        inputSchema: z.object({
          status: z
            .enum([
              "PENDING",
              "REGISTERING",
              "REGISTERED",
              "REGISTRATION_FAILED",
              "REJECTED",
            ])
            .nullable()
            .optional(),
        }),
        service,
        method: "devices",
        arguments: ({ status }) => [status],
        resultKey: "devices",
      }),
      serviceTool({
        name: "get_ios_device",
        title: "Get iOS device",
        description: "Get one enrolled or pending iOS device.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "device",
        arguments: ({ id }) => [id],
        resultKey: "device",
      }),
      serviceTool({
        name: "get_ios_device_firmware",
        title: "Get iOS device firmware",
        description: "Get firmware metadata discovered for an iOS device.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "deviceFirmware",
        arguments: ({ id }) => [id],
        resultKey: "firmware",
      }),
      serviceTool({
        name: "get_ios_device_settings",
        title: "Get iOS device settings",
        description: "Get redacted enrollment and App Store Connect settings.",
        inputSchema: z.object({}),
        service,
        method: "getSettings",
        arguments: () => [],
        resultKey: "settings",
      }),
      serviceTool({
        name: "rename_ios_device",
        title: "Rename iOS device",
        description: "Change the display name of an iOS device.",
        inputSchema: z.object({
          id: z.string().min(1),
          displayName: z.string().min(1),
        }),
        service,
        method: "renameDevice",
        arguments: (value) => [value.id, value.displayName],
        resultKey: "device",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "register_ios_device",
        title: "Register iOS device",
        description:
          "Register a pending iOS device with the Apple Developer portal.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "registerDevice",
        arguments: ({ id }) => [id],
        resultKey: "device",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "reject_ios_device",
        title: "Reject iOS device",
        description: "Reject a pending iOS device enrollment.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "rejectDevice",
        arguments: ({ id }) => [id],
        resultKey: "device",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_ios_device",
        title: "Delete iOS device",
        description: "Permanently delete an iOS device record.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "deleteDevice",
        arguments: ({ id }) => [id],
        resultKey: "deleted",
        annotations: DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
      }),
    ],
  };
}
