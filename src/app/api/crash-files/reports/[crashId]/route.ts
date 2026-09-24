import { authorizeUserOrApiKeyRequest } from "@/services/auth";
import { fileResponse, jsonError, NO_STORE } from "@/services/crashes/http";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ crashId: string }> },
): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  const { crashId } = await context.params;
  const variant =
    new URL(request.url).searchParams.get("variant")?.toUpperCase() ===
    "SYMBOLICATED"
      ? "SYMBOLICATED"
      : "ORIGINAL";
  const download = await getServerServices().crashesService.crashDownload(
    crashId,
    variant,
  );
  if (!download) return jsonError(404, "NOT_FOUND", "Crash report not found");
  if ("body" in download) {
    return new Response(download.body, {
      headers: {
        "content-type": download.contentType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
        "x-content-type-options": "nosniff",
        ...NO_STORE,
      },
    });
  }
  return fileResponse(request, download);
}
