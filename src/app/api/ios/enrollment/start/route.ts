import { resolvePublicOrigin } from "@/lib/public-origin";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const expected = new URL(request.url).origin;
  const forwarded = resolvePublicOrigin(request.headers)?.origin;
  return origin === expected || origin === forwarded;
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!sameOrigin(request)) {
      return new Response("Enrollment request origin is not allowed", {
        status: 403,
      });
    }
    const origin = resolvePublicOrigin(request.headers);
    if (!origin?.secure || origin.loopback) {
      return new Response(
        "Device enrollment requires a public HTTPS address. Set PUBLIC_BASE_URL or use a trusted HTTPS reverse proxy.",
        { status: 409 },
      );
    }
    const form = await request.formData();
    if (form.get("consent") !== "yes") {
      return new Response("Consent is required before device enrollment", {
        status: 400,
      });
    }
    const displayName = form.get("displayName");
    if (typeof displayName !== "string") {
      return new Response("Device label is required", { status: 400 });
    }
    const enrollment =
      await getServerServices().iosDevicesService.createEnrollment(displayName);
    const location = new URL("/api/ios/enrollment-profile", origin.origin);
    location.searchParams.set("token", enrollment.token);
    return new Response(null, {
      status: 303,
      headers: {
        location: location.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
}
