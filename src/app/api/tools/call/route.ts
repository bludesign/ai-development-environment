import * as z from "zod/v4";

import { CodebaseLookupError } from "@/services/codebases";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 180;

const inputSchema = z.object({
  groupId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const input = inputSchema.parse(await request.json());
    const result = await getServerServices().toolsService.callTool(input);
    return Response.json({ result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          error: {
            code: "INVALID_TOOL_CALL",
            message: z.prettifyError(error),
          },
        },
        { status: 400 },
      );
    }
    if (error instanceof CodebaseLookupError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "CODEBASE_NOT_FOUND" ? 404 : 409 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: { code: "TOOL_CALL_FAILED", message } },
      { status: 502 },
    );
  }
}
