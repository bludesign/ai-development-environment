import { allowed } from "@/lib/ios-registration-request";
import { optionalUserOrApiKeyRequest } from "@/services/auth";
import {
  crashErrorResponse,
  crashFilename,
  crashUploader,
  jsonError,
  NO_STORE,
  readCrashBody,
} from "@/services/crashes/http";
import { resolveClientIp } from "@/services/ios-devices/client-ip";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Reports one address may send per minute without signing in. */
const ANONYMOUS_REPORTS_PER_MINUTE = 30;

export async function POST(request: Request): Promise<Response> {
  const authorization = await optionalUserOrApiKeyRequest(request);
  if ("response" in authorization) return authorization.response;
  const { principal } = authorization;
  const service = getServerServices().crashesService;
  try {
    if (principal.kind !== "user") {
      const ip = resolveClientIp(request.headers)?.address ?? "unknown";
      if (
        !allowed("crash-reports", ip, Date.now(), ANONYMOUS_REPORTS_PER_MINUTE)
      ) {
        return jsonError(
          429,
          "RATE_LIMITED",
          "Too many crash reports from this address; retry in a minute",
        );
      }
      const settings = await service.settings();
      if (!settings.collectionEnabled) {
        await request.body?.cancel().catch(() => undefined);
        return Response.json(
          { collected: false, crashes: [] },
          { status: 202, headers: NO_STORE },
        );
      }
    }
    const bytes = await readCrashBody(request);
    const result = await service.ingestCrashReport({
      bytes,
      filename: crashFilename(request),
      uploader: crashUploader(principal, request),
    });
    return Response.json(
      {
        collected: true,
        duplicate: result.duplicate,
        crashes: result.crashes.map((crash) => ({
          id: crash.id,
          status: crash.status,
          url: `/crashes/${crash.id}`,
        })),
      },
      { status: result.duplicate ? 200 : 201, headers: NO_STORE },
    );
  } catch (error) {
    return crashErrorResponse(error, "Crash report upload");
  }
}
