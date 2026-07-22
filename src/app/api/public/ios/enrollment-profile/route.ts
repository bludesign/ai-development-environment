import { resolvePublicOrigin } from "@/lib/public-origin";
import { IosEnrollmentError, resolveClientIp } from "@/services/ios-devices";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const origin = resolvePublicOrigin(request.headers);
    if (!origin?.secure || origin.loopback) {
      return new Response("Device enrollment requires public HTTPS", {
        status: 409,
      });
    }
    const profile =
      await getServerServices().iosDevicesService.enrollmentProfile(
        token,
        origin.origin,
        resolveClientIp(request.headers),
      );
    const body = profile.buffer.slice(
      profile.byteOffset,
      profile.byteOffset + profile.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        "content-disposition":
          'attachment; filename="register-device.mobileconfig"',
        "content-type": "application/x-apple-aspen-config",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof IosEnrollmentError ? error.status : 500;
    if (status === 500) console.error("iOS enrollment profile failed:", error);
    return new Response(
      error instanceof IosEnrollmentError
        ? error.message
        : "Could not create the enrollment profile",
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
