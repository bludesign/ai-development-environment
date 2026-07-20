import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

const globalRateLimits = globalThis as typeof globalThis & {
  apnsRegistrationRateLimits?: Map<
    string,
    { startedAt: number; count: number }
  >;
};
const rateLimits =
  globalRateLimits.apnsRegistrationRateLimits ??
  (globalRateLimits.apnsRegistrationRateLimits = new Map());

function sourceIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

function allowed(ip: string, now = Date.now()): boolean {
  if (rateLimits.size > 10_000) {
    for (const [key, value] of rateLimits) {
      if (now - value.startedAt >= RATE_WINDOW_MS) rateLimits.delete(key);
    }
  }
  const current = rateLimits.get(ip);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT;
}

async function readLimitedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Request body is required");
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
        throw new RangeError("Request body exceeds 32 KiB");
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SyntaxError("Request body must be valid UTF-8 JSON");
  }
}

function response(body: unknown, status: number, extra: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extra },
  });
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return response({ error: "Content-Type must be application/json" }, 415);
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return response({ error: "Request body exceeds 32 KiB" }, 413);
  }
  const ip = sourceIp(request.headers);
  if (!allowed(ip)) {
    return response({ error: "Too many APNs registration requests" }, 429, {
      "retry-after": "60",
    });
  }
  try {
    const result = await getServerServices().pushNotificationsService.register(
      await readLimitedJson(request),
      ip === "unknown" ? null : ip,
    );
    return response(
      {
        id: result.registration.id,
        created: result.created,
        status: result.registration.status,
        lastRegisteredAt: result.registration.lastRegisteredAt.toISOString(),
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "Registration failed" },
      error instanceof RangeError ? 413 : 400,
    );
  }
}

export function resetApnsRegistrationRateLimitsForTests(): void {
  rateLimits.clear();
}
