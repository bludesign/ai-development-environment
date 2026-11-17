import {
  guardedRegistration,
  jsonResponse,
} from "@/lib/ios-registration-request";
import {
  crossOriginError,
  PrincipalResolutionError,
  principalErrorResponse,
  requireUserPrincipal,
} from "@/services/auth";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

async function subscriptionRequest(
  request: Request,
  deleting: boolean,
): Promise<Response> {
  const originError = crossOriginError(request);
  if (originError) return originError;
  let principal;
  try {
    principal = await requireUserPrincipal(request.headers);
  } catch (error) {
    if (error instanceof PrincipalResolutionError)
      return principalErrorResponse(error);
    throw error;
  }
  return guardedRegistration(
    request,
    {
      namespace: "ios-status-subscriptions",
      rejectionMessage: "Too many status subscription requests",
    },
    async (body) => {
      const { iosStatusService } = getServerServices();
      return jsonResponse(
        await (deleting
          ? iosStatusService.unregister(principal, body)
          : iosStatusService.register(principal, body)),
        200,
      );
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  return subscriptionRequest(request, false);
}

export async function DELETE(request: Request): Promise<Response> {
  return subscriptionRequest(request, true);
}
