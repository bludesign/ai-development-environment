import { authorizeUserOrApiKeyRequest } from "@/services/auth";
import { CrashRequestError } from "@/services/crashes/crashes.service";
import {
  crashErrorResponse,
  dsymUploader,
  NO_STORE,
} from "@/services/crashes/http";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  try {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error();
      }
      body = parsed as Record<string, unknown>;
    } catch {
      throw new CrashRequestError("The body must be a JSON object");
    }
    const { upload, chunkBytes } =
      await getServerServices().crashesService.beginResumableUpload({
        filename: typeof body.filename === "string" ? body.filename : "",
        sizeBytes: Number(body.sizeBytes),
        sha256:
          typeof body.sha256 === "string" && body.sha256
            ? body.sha256.toLowerCase()
            : null,
        metadata: {
          buildId: body.buildId as string | null,
          url: body.url as string | null,
          projectName: body.projectName as string | null,
        },
        uploader: dsymUploader(authorization.principal),
      });
    return Response.json(
      { id: upload.id, uploadOffset: 0, chunkBytes },
      {
        status: 201,
        headers: {
          ...NO_STORE,
          location: `/api/dsyms/uploads/${upload.id}`,
          "Upload-Offset": "0",
        },
      },
    );
  } catch (error) {
    return crashErrorResponse(error, "dSYM upload start");
  }
}
