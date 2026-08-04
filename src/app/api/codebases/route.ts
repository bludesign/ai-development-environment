import { getServerServices } from "@/services/server-services";
import { requireUserRequest } from "@/services/auth";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const authenticationError = await requireUserRequest(request);
  if (authenticationError) return authenticationError;
  try {
    const codebases = await getServerServices().codebaseToolsService.list();
    return Response.json({ codebases });
  } catch (error) {
    console.error("Codebases REST request failed:", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      { status: 500 },
    );
  }
}
