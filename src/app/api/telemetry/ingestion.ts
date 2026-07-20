import { resolveClientIp } from "@/services/ios-devices";
import { getServerServices } from "@/services/server-services";
import {
  TELEMETRY_MAX_BODY_BYTES,
  TelemetryValidationError,
  parseAnalyticsEvent,
  parseConsoleLog,
  parseIngestionBody,
} from "@/services/telemetry";

type IngestionKind = "CONSOLE" | "ANALYTICS";

async function readLimitedJson(request: Request): Promise<unknown> {
  const type = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (type !== "application/json") {
    throw new TelemetryValidationError(
      "Content-Type must be application/json",
      "UNSUPPORTED_MEDIA_TYPE",
      415,
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > TELEMETRY_MAX_BODY_BYTES
  ) {
    throw new TelemetryValidationError(
      "Request body exceeds 2 MiB",
      "PAYLOAD_TOO_LARGE",
      413,
    );
  }
  if (!request.body)
    throw new TelemetryValidationError("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > TELEMETRY_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TelemetryValidationError(
          "Request body exceeds 2 MiB",
          "PAYLOAD_TOO_LARGE",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TelemetryValidationError("Request body must contain valid JSON");
  }
}

export async function ingestTelemetry(
  request: Request,
  kind: IngestionKind,
): Promise<Response> {
  try {
    const body = await readLimitedJson(request);
    const ip = resolveClientIp(request.headers)?.address ?? "unknown";
    const service = getServerServices().telemetryService;
    const result =
      kind === "CONSOLE"
        ? await service.ingestConsole(
            parseIngestionBody(body, parseConsoleLog),
            ip,
          )
        : await service.ingestAnalytics(
            parseIngestionBody(body, parseAnalyticsEvent),
            ip,
          );
    return Response.json(result, {
      status: result.collected ? 201 : 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof TelemetryValidationError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    console.error(`${kind} telemetry ingestion failed:`, error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
