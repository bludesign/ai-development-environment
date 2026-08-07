import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new RangeError("GitLab webhook payload is too large");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) throw new Error("GitLab webhook payload is required");
    if (bytes.length > MAX_BODY_BYTES) {
      throw new RangeError("GitLab webhook payload is too large");
    }
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
