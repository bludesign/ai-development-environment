import * as z from "zod/v4";

import type { CredentialService } from "@/services/credentials";
import type { PollingService } from "@/services/polling";
import type { SystemStatusService } from "@/services/system-status";

import type { BuiltInToolGroup } from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createSystemToolGroup(
  status: SystemStatusService,
  polling: PollingService,
  credentials: CredentialService,
): BuiltInToolGroup {
  return {
    id: "builtin:system",
    name: "System",
    children: [],
    tools: [
      serviceTool({
        name: "get_system_status",
        title: "Get system status",
        description: "Get the control plane's aggregated operational health.",
        inputSchema: z.object({}),
        service: status,
        method: "status",
        arguments: () => [],
        resultKey: "status",
      }),
      serviceTool({
        name: "get_polling_operations",
        title: "Get polling operations",
        description:
          "List registered background polling operations and their current states.",
        inputSchema: z.object({}),
        service: polling,
        method: "list",
        arguments: () => [],
        resultKey: "operations",
      }),
      serviceTool({
        name: "get_credential_store_status",
        title: "Get credential store status",
        description:
          "Get credential-store health without returning credential values.",
        inputSchema: z.object({}),
        service: credentials,
        method: "status",
        arguments: () => [],
        resultKey: "status",
      }),
      serviceTool({
        name: "get_credential_metadata",
        title: "Get credential metadata",
        description:
          "List redacted credential metadata; values are never returned.",
        inputSchema: z.object({}),
        service: credentials,
        method: "list",
        arguments: () => [],
        resultKey: "credentials",
      }),
    ],
  };
}
