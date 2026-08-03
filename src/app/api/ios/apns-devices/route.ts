import {
  guardedRegistration,
  jsonResponse,
  resetRateLimitsForTests,
} from "@/lib/ios-registration-request";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

const RATE_LIMIT_NAMESPACE = "apns-devices";

export async function POST(request: Request): Promise<Response> {
  return guardedRegistration(
    request,
    {
      namespace: RATE_LIMIT_NAMESPACE,
      rejectionMessage: "Too many APNs registration requests",
    },
    async (body, ip) => {
      const result =
        await getServerServices().pushNotificationsService.register(body, ip);
      return jsonResponse(
        {
          id: result.registration.id,
          created: result.created,
          status: result.registration.status,
          lastRegisteredAt: result.registration.lastRegisteredAt.toISOString(),
        },
        result.created ? 201 : 200,
      );
    },
  );
}

export function resetApnsRegistrationRateLimitsForTests(): void {
  resetRateLimitsForTests(RATE_LIMIT_NAMESPACE);
}
