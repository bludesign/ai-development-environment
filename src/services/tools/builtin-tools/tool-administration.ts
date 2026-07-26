import * as z from "zod/v4";

import type { ToolCallAuditService } from "../tool-call-audit.service";
import {
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createToolAdministrationGroup(
  audit: ToolCallAuditService,
  testExternalServer: (id: string) => Promise<unknown>,
): BuiltInToolGroup {
  return {
    id: "builtin:tool-administration",
    name: "Tool Administration",
    children: [],
    tools: [
      serviceTool({
        name: "test_external_mcp_server",
        title: "Test external MCP server",
        description:
          "Connect to a configured external MCP server and report its tool count without returning saved headers.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service: { testExternalServer },
        method: "testExternalServer",
        arguments: ({ id }) => [id],
        resultKey: "status",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_tool_call_history",
        title: "Get tool call history",
        description:
          "List redacted tool-call audit records. Arguments are represented only by SHA-256 hashes.",
        inputSchema: z.object({
          first: z.number().int().min(1).max(500).default(100),
          toolName: z.string().nullable().optional(),
          resultStatus: z
            .enum(["RUNNING", "SUCCEEDED", "FAILED"])
            .nullable()
            .optional(),
        }),
        service: audit,
        method: "list",
        resultKey: "calls",
      }),
      serviceTool({
        name: "get_tool_call",
        title: "Get tool call",
        description: "Get one redacted tool-call audit record by ID.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service: audit,
        method: "get",
        arguments: ({ id }) => [id],
        resultKey: "call",
      }),
    ],
  };
}
