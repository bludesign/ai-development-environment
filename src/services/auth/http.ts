import "server-only";

import { isSameOriginRequest } from "@/lib/app-origins";

import { getAuthRuntimeConfig } from "./auth-config";
import {
  PrincipalResolutionError,
  principalErrorResponse,
  requireUserPrincipal,
  usesAmbientCredential,
} from "./principal";

/**
 * Refuse a cross-origin request that would be authenticated by the session
 * cookie alone.
 *
 * Applied wherever a route accepts the cookie, so the browser's `SameSite`
 * default is a second line rather than the only one. Token-authenticated callers
 * are untouched: a native app or MCP client sets its credential deliberately, and
 * some of them do send an `Origin` this server has never heard of.
 */
export function crossOriginError(request: Request): Response | null {
  if (!usesAmbientCredential(request.headers)) return null;
  if (isSameOriginRequest(request, getAuthRuntimeConfig().trustProxyHeaders)) {
    return null;
  }
  return Response.json(
    {
      error: {
        code: "CROSS_ORIGIN_REQUEST",
        message:
          "A session-authenticated request must come from this site. Use an API key for cross-origin access.",
      },
    },
    { status: 403 },
  );
}

export async function requireUserRequest(
  request: Request,
): Promise<Response | null> {
  const crossOrigin = crossOriginError(request);
  if (crossOrigin) return crossOrigin;
  try {
    await requireUserPrincipal(request.headers);
    return null;
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return principalErrorResponse(error);
    }
    throw error;
  }
}
