import { getServerServices } from "@/services/server-services";
import { authorizeToolRequest } from "@/services/tools";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeToolRequest(request, "TOOLS_PAGE");
  if ("response" in authorization) return authorization.response;
  try {
    return Response.json(await getServerServices().toolsService.catalog());
  } catch (error) {
    console.error("Tool catalog request failed:", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      { status: 500 },
    );
  }
}
