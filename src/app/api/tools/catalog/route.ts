import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(): Promise<Response> {
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
