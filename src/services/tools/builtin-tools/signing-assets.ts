import * as z from "zod/v4";

import type { SigningAssetsService } from "@/services/signing-assets";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createSigningAssetToolGroup(
  service: SigningAssetsService,
): BuiltInToolGroup {
  return {
    id: "builtin:signing-assets",
    name: "Signing Assets",
    children: [],
    tools: [
      serviceTool({
        name: "get_signing_agents",
        title: "Get signing agents",
        description: "List agents and signing-asset availability.",
        inputSchema: z.object({}),
        service,
        method: "agents",
        arguments: () => [],
        resultKey: "agents",
      }),
      serviceTool({
        name: "get_signing_profiles",
        title: "Get signing profiles",
        description:
          "List provisioning-profile metadata without profile contents.",
        inputSchema: z.object({}),
        service,
        method: "profiles",
        arguments: () => [],
        resultKey: "profiles",
      }),
      serviceTool({
        name: "get_signing_profile",
        title: "Get signing profile",
        description: "Get one provisioning profile and matched devices.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "profile",
        arguments: ({ id }) => [id],
        resultKey: "profile",
      }),
      serviceTool({
        name: "get_signing_certificates",
        title: "Get signing certificates",
        description:
          "List signing-certificate metadata without private keys or P12 files.",
        inputSchema: z.object({}),
        service,
        method: "certificates",
        arguments: () => [],
        resultKey: "certificates",
      }),
      serviceTool({
        name: "get_signing_operations",
        title: "Get signing operations",
        description: "List recent signing-asset operation history.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(500).default(50),
        }),
        service,
        method: "operations",
        arguments: ({ limit }) => [limit],
        resultKey: "operations",
      }),
      serviceTool({
        name: "get_apple_portal_inventory",
        title: "Get Apple portal inventory",
        description:
          "Get provisioning profiles, certificates, devices, and identifiers visible in the Apple Developer portal.",
        inputSchema: z.object({}),
        service,
        method: "portalInventory",
        arguments: () => [],
        resultKey: "inventory",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "refresh_signing_assets",
        title: "Refresh signing assets",
        description:
          "Refresh signing-asset inventory from selected or all agents.",
        inputSchema: z.object({
          agentIds: z.array(z.string().min(1)).optional(),
        }),
        service,
        method: "refresh",
        arguments: ({ agentIds }) => [agentIds],
        resultKey: "operation",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "download_signing_profile",
        title: "Download signing profile",
        description:
          "Download an Apple provisioning profile to an agent; profile contents are not returned.",
        inputSchema: z.object({
          uuid: z.string().min(1),
          agentId: z.string().min(1),
        }),
        service,
        method: "downloadProfile",
        arguments: (value) => [value.uuid, value.agentId],
        resultKey: "operation",
        mapResult: (value) => {
          const result = value as { uuid?: unknown; filename?: unknown };
          return {
            uuid: typeof result.uuid === "string" ? result.uuid : null,
            filename:
              typeof result.filename === "string" ? result.filename : null,
          };
        },
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "sync_signing_profile",
        title: "Sync signing profile",
        description: "Synchronize a provisioning profile between agents.",
        inputSchema: z.object({
          uuid: z.string().min(1),
          sourceAgentId: z.string().min(1),
          targetAgentIds: z.array(z.string().min(1)).min(1),
        }),
        service,
        method: "syncProfile",
        arguments: (value) => [
          value.uuid,
          value.sourceAgentId,
          value.targetAgentIds,
        ],
        resultKey: "operation",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_signing_profile",
        title: "Delete signing profile",
        description: "Delete a provisioning profile from selected agents.",
        inputSchema: z.object({
          uuid: z.string().min(1),
          agentIds: z.array(z.string().min(1)).min(1),
        }),
        service,
        method: "deleteProfile",
        arguments: (value) => [value.uuid, value.agentIds],
        resultKey: "operation",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_expired_signing_profiles",
        title: "Delete expired signing profiles",
        description:
          "Delete expired provisioning profiles from selected or all agents.",
        inputSchema: z.object({
          agentIds: z.array(z.string().min(1)).optional(),
        }),
        service,
        method: "deleteExpiredProfiles",
        arguments: ({ agentIds }) => [agentIds],
        resultKey: "operation",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
    ],
  };
}
