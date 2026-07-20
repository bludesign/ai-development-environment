import { resolvePublicOrigin } from "@/lib/public-origin";
import { IosEnrollmentError, resolveClientIp } from "@/services/ios-devices";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_RESPONSE_BYTES = 128 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) {
      return new Response("Device response is too large", { status: 413 });
    }
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!raw.byteLength || raw.byteLength > MAX_RESPONSE_BYTES) {
      return new Response("Device response is empty or too large", {
        status: raw.byteLength ? 413 : 400,
      });
    }
    const url = new URL(request.url);
    await getServerServices().iosDevicesService.completeEnrollment(
      url.searchParams.get("token") ?? "",
      raw,
      resolveClientIp(request.headers),
    );
    const origin = resolvePublicOrigin(request.headers)?.origin ?? url.origin;
    return new Response(null, {
      // iOS Profile Service uses a permanent redirect as the browser hand-off
      // after posting device attributes. A 303 is followed inside the profile
      // installer, which then tries to parse the HTML landing page as another
      // profile and reports "Invalid Profile" despite a successful callback.
      status: 301,
      headers: {
        location: new URL("/api/ios/enrollment-complete", origin).toString(),
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
