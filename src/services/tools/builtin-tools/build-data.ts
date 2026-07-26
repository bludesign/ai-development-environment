import * as z from "zod/v4";

import type { BuildDataService } from "@/services/build-data";

import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createBuildDataToolGroup(
  service: BuildDataService,
): BuiltInToolGroup {
  return {
    id: "builtin:build-data",
    name: "Build Data",
    children: [],
    tools: [
      serviceTool({
        name: "get_build_data_collection",
        title: "Get build data collection",
        description: "Get a derived-data collection and its entries.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "getCollection",
        arguments: ({ id }) => [id],
        resultKey: "collection",
      }),
      serviceTool({
        name: "get_build_data_deletion_history",
        title: "Get build data deletion history",
        description: "Get paginated build-data cleanup history.",
        inputSchema: z.object({
          first: z.number().int().min(1).max(500).default(100),
          after: z.string().nullable().optional(),
        }),
        service,
        method: "history",
        arguments: ({ first, after }) => [first, after],
        resultKey: "page",
      }),
      serviceTool({
        name: "refresh_build_data",
        title: "Refresh build data",
        description:
          "Collect current derived-data entries from enrolled agents.",
        inputSchema: z.object({ requestId: z.string().nullable().optional() }),
        service,
        method: "refresh",
        arguments: ({ requestId }) => [requestId],
        resultKey: "collection",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "calculate_build_data_sizes",
        title: "Calculate build data sizes",
        description:
          "Calculate accurate sizes for selected build-data entries.",
        inputSchema: z.object({
          collectionId: z.string().min(1),
          entryIds: z.array(z.string().min(1)).min(1),
          requestId: z.string().min(1),
        }),
        service,
        method: "calculateSizes",
        arguments: (value) => [
          value.collectionId,
          value.entryIds,
          value.requestId,
        ],
        resultKey: "collection",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_build_data_entries",
        title: "Delete build data entries",
        description: "Delete selected derived-data entries from their agents.",
        inputSchema: z.object({
          collectionId: z.string().min(1),
          entryIds: z.array(z.string().min(1)).min(1),
          requestId: z.string().min(1),
          overrideProtection: z.boolean().default(false),
        }),
        service,
        method: "deleteEntries",
        arguments: (value) => [
          value.collectionId,
          value.entryIds,
          value.requestId,
          value.overrideProtection,
        ],
        resultKey: "collection",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "clear_build_data_history",
        title: "Clear build data history",
        description: "Permanently clear build-data deletion history.",
        inputSchema: z.object({}),
        service,
        method: "clearHistory",
        arguments: () => [],
        resultKey: "count",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "set_build_data_lock",
        title: "Set build data lock",
        description:
          "Lock or unlock a build-data entry to control cleanup eligibility.",
        inputSchema: z.object({
          collectionId: z.string().min(1),
          entryId: z.string().min(1),
          locked: z.boolean(),
        }),
        service,
        method: "setEntryLocked",
        arguments: (value) => [value.collectionId, value.entryId, value.locked],
        resultKey: "entry",
        annotations: WRITE_ANNOTATIONS,
      }),
    ],
  };
}
