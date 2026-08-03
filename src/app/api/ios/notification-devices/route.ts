import {
  guardedRegistration,
  jsonResponse,
  resetRateLimitsForTests,
} from "@/lib/ios-registration-request";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const RATE_LIMIT_NAMESPACE = "notification-devices";

/**
 * Where the control plane's own iOS app posts its APNs token so this server can deliver the
 * notifications shown at `/notifications`. Separate from `/api/ios/apns-devices`, which feeds the
 * push-notifications test console with devices belonging to apps built using this server.
 */
export async function POST(request: Request): Promise<Response> {
  return guardedRegistration(
    request,
    {
      namespace: RATE_LIMIT_NAMESPACE,
      rejectionMessage: "Too many device registration requests",
    },
    async (body, ip) => {
      const { notificationsService } = getServerServices();
      const result = await notificationsService.registerDevice(body, ip);
      return jsonResponse(
        {
          id: result.device.id,
          created: result.created,
          status: result.device.status,
          lastRegisteredAt: result.device.lastRegisteredAt.toISOString(),
        },
        result.created ? 201 : 200,
      );
    },
  );
}

export function resetNotificationDeviceRateLimitsForTests(): void {
  resetRateLimitsForTests(RATE_LIMIT_NAMESPACE);
}
