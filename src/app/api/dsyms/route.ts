import { authorizeUserOrApiKeyRequest } from "@/services/auth";
import {
  crashErrorResponse,
  dsymUploadBody,
  dsymUploader,
  NO_STORE,
  receiveDsymZip,
} from "@/services/crashes/http";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  try {
    const zip = await receiveDsymZip(request);
    const { upload, duplicate } =
      await getServerServices().crashesService.importDsymZip({
        zipPath: zip.path,
        filename: zip.filename,
        sha256: zip.sha256,
        sizeBytes: zip.size,
        metadata: zip.metadata,
        uploader: dsymUploader(authorization.principal),
      });
    return Response.json(dsymUploadBody(upload, duplicate), {
      status: duplicate ? 200 : 201,
      headers: NO_STORE,
    });
  } catch (error) {
    return crashErrorResponse(error, "dSYM upload");
  }
}
