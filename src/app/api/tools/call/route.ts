import * as z from "zod/v4";

import { CodebaseLookupError } from "@/services/codebases";
import { getServerServices } from "@/services/server-services";
import { authorizeToolRequest } from "@/services/tools";

export const runtime = "nodejs";
export const maxDuration = 180;

const inputSchema = z.object({
  groupId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeToolRequest(request, "TOOLS_PAGE");
  if ("response" in authorization) return authorization.response;
  const headers = { "x-request-id": authorization.context.correlationId };
  try {
    const input = inputSchema.parse(await request.json());
    const result = await getServerServices().toolsService.callTool(
      input,
      authorization.context,
    );
    return Response.json(
      { result, requestId: authorization.context.correlationId },
      { headers },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          error: {
            code: "INVALID_TOOL_CALL",
            message: z.prettifyError(error),
          },
        },
        { status: 400, headers },
      );
    }
    if (error instanceof CodebaseLookupError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        {
          status: error.code === "CODEBASE_NOT_FOUND" ? 404 : 409,
          headers,
        },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: { code: "TOOL_CALL_FAILED", message } },
      { status: 502, headers },
    );
  }
}
