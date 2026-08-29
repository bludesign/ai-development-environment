import * as z from "zod/v4";

import type { TailscaleServeService } from "@/services/tailscale";

import {
  DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

const assignment = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean(),
});

const template = z.object({
  id: z.string().min(1).nullable().optional(),
  expectedRevision: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  protocol: z.enum(["HTTP", "HTTPS", "TCP", "TLS_TERMINATED_TCP"]),
  listenPort: z.number().int().min(1).max(65_535),
  mountPath: z.string().default("/"),
  destinationProtocol: z.enum(["HTTP", "HTTPS", "HTTPS_INSECURE", "TCP"]),
  destinationPort: z.number().int().min(1).max(65_535),
  destinationPath: z.string().default(""),
  funnel: z.boolean(),
  appCapabilities: z.array(z.string()).default([]),
  proxyProtocol: z.enum(["NONE", "V1", "V2"]),
  assignments: z.array(assignment).min(1),
});

export function createTailscaleToolGroup(
  service: TailscaleServeService,
): BuiltInToolGroup {
  return {
    id: "builtin:tailscale",
    name: "Tailscale",
    children: [],
    tools: [
      serviceTool({
        name: "get_tailscale_serve_overview",
        title: "Get Tailscale Serve overview",
        description:
          "Get fleet templates, agent Tailscale identities, desired state, and observed routes.",
        inputSchema: z.object({}),
        service,
        method: "overview",
        arguments: () => [],
        resultKey: "overview",
        annotations: READ_ONLY_ANNOTATIONS,
      }),
      serviceTool({
        name: "inspect_tailscale_serve",
        title: "Inspect Tailscale Serve",
        description:
          "Queue typed read-only Tailscale CLI inspection jobs on selected agents.",
        inputSchema: z.object({
          agentIds: z.array(z.string().min(1)).default([]),
          requestId: z.string().min(1),
        }),
        service,
        method: "inspect",
        arguments: ({ agentIds, requestId }) => [agentIds, requestId],
        resultKey: "operation",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "upsert_tailscale_serve_template",
        title: "Upsert Tailscale Serve template",
        description:
          "Create or update a validated fleet template and apply it to enabled agents.",
        inputSchema: z.object({
          input: template,
          requestId: z.string().min(1),
        }),
        service,
        method: "upsert",
        arguments: ({ input, requestId }) => [input, requestId],
        resultKey: "operation",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "set_tailscale_serve_agent_enabled",
        title: "Set Tailscale Serve agent enabled",
        description:
          "Enable or disable one retained template assignment on an agent.",
        inputSchema: z.object({
          templateId: z.string().min(1),
          agentId: z.string().min(1),
          enabled: z.boolean(),
          expectedRevision: z.number().int().positive(),
          requestId: z.string().min(1),
        }),
        service,
        method: "setAgentEnabled",
        arguments: (value) => [
          value.templateId,
          value.agentId,
          value.enabled,
          value.expectedRevision,
          value.requestId,
        ],
        resultKey: "operation",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_tailscale_serve_template",
        title: "Delete Tailscale Serve template",
        description:
          "Remove a template from every enabled or observed agent, then delete it.",
        inputSchema: z.object({
          id: z.string().min(1),
          expectedRevision: z.number().int().positive(),
          requestId: z.string().min(1),
        }),
        service,
        method: "delete",
        arguments: ({ id, expectedRevision, requestId }) => [
          id,
          expectedRevision,
          requestId,
        ],
        resultKey: "operation",
        annotations: DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
      }),
    ],
  };
}
