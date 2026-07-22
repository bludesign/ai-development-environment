import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024 * 1024;

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RangeError("GitHub webhook payload is too large");
  }
  if (!request.body) throw new Error("GitHub webhook payload is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("GitHub webhook payload is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readLimitedBody(request);
    const result =
      await getServerServices().gitHubActionsNotificationsService.handleWebhook(
        {
          body,
          signature: request.headers.get("x-hub-signature-256"),
          event: request.headers.get("x-github-event"),
          deliveryId: request.headers.get("x-github-delivery"),
        },
      );
    return Response.json(result, {
      status: result.outcome === "PROCESSED" ? 200 : 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof RangeError
        ? 413
        : /signature/i.test(message)
          ? 401
          : /not configured/i.test(message)
            ? 503
            : 400;
    return Response.json(
      { error: message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
