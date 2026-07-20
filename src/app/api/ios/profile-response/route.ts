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
      status: 303,
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
