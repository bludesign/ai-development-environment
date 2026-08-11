import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024 * 1024;

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RangeError("GitLab webhook payload is too large");
  }
  if (!request.body) throw new Error("GitLab webhook payload is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError("GitLab webhook payload is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
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
    const bytes = await readLimitedBody(request);
    if (!bytes.length) throw new Error("GitLab webhook payload is required");
    const result = await getServerServices().gitLabService.handleWebhook({
      rawBody: new TextDecoder().decode(bytes),
      headers: request.headers,
    });
    return Response.json(result, {
      status: result.duplicate ? 202 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof RangeError
        ? 413
        : /signature|timestamp|signing token/i.test(message)
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
