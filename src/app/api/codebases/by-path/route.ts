import { CodebaseLookupError } from "@/services/codebases";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const path = new URL(request.url).searchParams.get("path");
  if (path === null || path.trim().length === 0) {
    return Response.json(
      {
        error: {
          code: "INVALID_PATH",
          message: "A non-empty path query parameter is required",
        },
      },
      { status: 400 },
    );
  }
  try {
    const codebase =
      await getServerServices().codebaseToolsService.getByPath(path);
    return Response.json({ codebase });
  } catch (error) {
    if (error instanceof CodebaseLookupError) {
      const status =
        error.code === "CODEBASE_NOT_FOUND"
          ? 404
          : error.code === "AMBIGUOUS_PATH"
            ? 409
            : 400;
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.matches.length ? { matches: error.matches } : {}),
          },
        },
        { status },
      );
    }
    console.error("Codebase REST lookup failed:", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      { status: 500 },
    );
  }
}
