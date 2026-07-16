import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
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
