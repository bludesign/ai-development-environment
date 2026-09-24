import { authorizeUserOrApiKeyRequest } from "@/services/auth";
import { DSYM_UPLOAD_CHUNK_BYTES } from "@/services/crashes/crash-store";
import { CrashRequestError } from "@/services/crashes/crashes.service";
import {
  crashErrorResponse,
  jsonError,
  NO_STORE,
  ownerKey,
} from "@/services/crashes/http";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 300;

type Context = { params: Promise<{ uploadId: string }> };

export async function HEAD(
  request: Request,
  context: Context,
): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) {
    return new Response(null, { status: authorization.response.status });
  }
  try {
    const { uploadId } = await context.params;
    const upload = await getServerServices().crashesService.resumableUpload(
      uploadId,
      ownerKey(authorization.principal),
    );
    return new Response(null, {
      status: 204,
      headers: {
        ...NO_STORE,
        "Upload-Offset": String(upload.uploadOffset),
        "Upload-Length": String(upload.sizeBytes),
        "Upload-Status": upload.status,
      },
    });
  } catch (error) {
    const response = crashErrorResponse(error, "dSYM upload status");
    return new Response(null, { status: response.status });
  }
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  try {
    const length = Number(request.headers.get("content-length"));
    if (
      request.headers.get("content-length") !== null &&
      (!Number.isSafeInteger(length) || length > DSYM_UPLOAD_CHUNK_BYTES)
    ) {
      return jsonError(
        413,
        "PAYLOAD_TOO_LARGE",
        "Upload chunks must be at most 16 MiB",
      );
    }
    const offsetHeader = request.headers.get("upload-offset")?.trim();
    const offset = offsetHeader ? Number(offsetHeader) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new CrashRequestError("The Upload-Offset header is required");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const { uploadId } = await context.params;
    const upload =
      await getServerServices().crashesService.appendResumableChunk({
        id: uploadId,
        ownerKey: ownerKey(authorization.principal),
        offset,
        bytes,
      });
    return new Response(null, {
      status: 204,
      headers: {
        ...NO_STORE,
        "Upload-Offset": String(upload.uploadOffset),
        "Upload-Length": String(upload.sizeBytes),
      },
    });
  } catch (error) {
    return crashErrorResponse(error, "dSYM upload chunk");
  }
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  try {
    const { uploadId } = await context.params;
    const service = getServerServices().crashesService;
    const upload = await service.resumableUpload(
      uploadId,
      ownerKey(authorization.principal),
    );
    if (upload.status !== "UPLOADING") {
      throw new CrashRequestError(
        "Only unfinished uploads can be cancelled here",
        409,
        "CONFLICT",
      );
    }
    await service.deleteDsymUpload(upload.id);
    return new Response(null, { status: 204, headers: NO_STORE });
  } catch (error) {
    return crashErrorResponse(error, "dSYM upload cancel");
  }
}
