import { resolvePublicOrigin } from "@/lib/public-origin";
import { IosEnrollmentError, resolveClientIp } from "@/services/ios-devices";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_RESPONSE_BYTES = 128 * 1024;

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
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
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) {
      return new Response("Device response is too large", { status: 413 });
    }
    const raw = await readLimitedBody(request);
    if (!raw || !raw.byteLength) {
      return new Response(
        raw ? "Device response is empty" : "Device response is too large",
        { status: raw ? 400 : 413 },
      );
    }
    const url = new URL(request.url);
    const device =
      await getServerServices().iosDevicesService.completeEnrollment(
        url.searchParams.get("token") ?? "",
        raw,
        resolveClientIp(request.headers),
      );
    if (!device) throw new Error("Completed enrollment device is unavailable");
    const origin = resolvePublicOrigin(request.headers)?.origin ?? url.origin;
    const completionUrl = new URL(
      "/api/public/ios/enrollment-complete",
      origin,
    );
    completionUrl.searchParams.set("deviceId", device.id);
    return new Response(null, {
      // iOS Profile Service uses a permanent redirect as the browser hand-off
      // after posting device attributes. A 303 is followed inside the profile
      // installer, which then tries to parse the HTML landing page as another
      // profile and reports "Invalid Profile" despite a successful callback.
      status: 301,
      headers: {
        location: completionUrl.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    const status = error instanceof IosEnrollmentError ? error.status : 500;
    if (status === 500) console.error("iOS profile response failed:", error);
    return new Response(
      error instanceof IosEnrollmentError
        ? error.message
        : "Could not validate the device response",
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
