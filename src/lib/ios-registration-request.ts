const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

type RateLimitBucket = { startedAt: number; count: number };

const globalRateLimits = globalThis as typeof globalThis & {
  iosRegistrationRateLimits?: Map<string, Map<string, RateLimitBucket>>;
};

// Route modules are re-evaluated on every hot reload in development, so the buckets hang off
// globalThis to survive that. Each route gets its own namespace: a device registering for
// notifications should not spend the push-console's budget.
const namespaces =
  globalRateLimits.iosRegistrationRateLimits ??
  (globalRateLimits.iosRegistrationRateLimits = new Map());

function bucketsFor(namespace: string): Map<string, RateLimitBucket> {
  const existing = namespaces.get(namespace);
  if (existing) return existing;
  const created = new Map<string, RateLimitBucket>();
  namespaces.set(namespace, created);
  return created;
}

export function sourceIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export function allowed(
  namespace: string,
  ip: string,
  now = Date.now(),
): boolean {
  const rateLimits = bucketsFor(namespace);
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

export function resetRateLimitsForTests(namespace?: string): void {
  if (namespace) namespaces.get(namespace)?.clear();
  else namespaces.clear();
}

export async function readLimitedJson(request: Request): Promise<unknown> {
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

export function jsonResponse(
  body: unknown,
  status: number,
  extra: HeadersInit = {},
) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extra },
  });
}

/**
 * Applies the shared content-type, size, and rate-limit guards before handing the parsed body to
 * `handle`. Returns the guard's rejection instead when any of them trips.
 */
export async function guardedRegistration(
  request: Request,
  options: { namespace: string; rejectionMessage: string },
  handle: (body: unknown, ip: string | null) => Promise<Response>,
): Promise<Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonResponse(
      { error: "Content-Type must be application/json" },
      415,
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Request body exceeds 32 KiB" }, 413);
  }
  const ip = sourceIp(request.headers);
  if (!allowed(options.namespace, ip)) {
    return jsonResponse({ error: options.rejectionMessage }, 429, {
      "retry-after": "60",
    });
  }
  try {
    return await handle(
      await readLimitedJson(request),
      ip === "unknown" ? null : ip,
    );
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Registration failed" },
      error instanceof RangeError ? 413 : 400,
    );
  }
}
