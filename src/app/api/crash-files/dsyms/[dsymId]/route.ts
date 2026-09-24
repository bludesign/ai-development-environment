import { authorizeUserOrApiKeyRequest } from "@/services/auth";
import { jsonError, zipResponse } from "@/services/crashes/http";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 1800;

/** Downloads one dSYM bundle as a zip Xcode and `atos` can open. */
export async function GET(
  request: Request,
  context: { params: Promise<{ dsymId: string }> },
): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  const { dsymId } = await context.params;
  const bundle =
    await getServerServices().crashesService.dsymBundleFiles(dsymId);
  if (!bundle) return jsonError(404, "NOT_FOUND", "dSYM not found");
  return zipResponse(bundle.filename, bundle.files);
}
