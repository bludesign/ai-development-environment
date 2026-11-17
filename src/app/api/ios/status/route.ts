import {
  allowed,
  jsonResponse,
  sourceIp,
} from "@/lib/ios-registration-request";
import { requireUserRequest } from "@/services/auth";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

/** A small authenticated snapshot for WidgetKit timelines and the host app's Live Activity. */
export async function GET(request: Request): Promise<Response> {
  const authenticationError = await requireUserRequest(request);
  if (authenticationError) return authenticationError;
  if (!allowed("ios-status", sourceIp(request.headers), Date.now(), 120)) {
    return jsonResponse({ error: "Too many status requests" }, 429, {
      "retry-after": "60",
    });
  }
  return jsonResponse(
    await getServerServices().iosStatusService.snapshot(),
    200,
  );
}
