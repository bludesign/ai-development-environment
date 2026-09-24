import { authorizeUserOrApiKeyRequest } from "@/services/auth";
import {
  crashErrorResponse,
  dsymUploadBody,
  NO_STORE,
  ownerKey,
} from "@/services/crashes/http";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  context: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  try {
    const { uploadId } = await context.params;
    const { upload, duplicate } =
      await getServerServices().crashesService.completeResumableUpload(
        uploadId,
        ownerKey(authorization.principal),
      );
    return Response.json(dsymUploadBody(upload, duplicate), {
      status: duplicate ? 200 : 201,
      headers: NO_STORE,
    });
  } catch (error) {
    return crashErrorResponse(error, "dSYM upload completion");
  }
}
