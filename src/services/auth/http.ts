import "server-only";

import { isSameOriginRequest } from "@/lib/app-origins";

import { getAuthRuntimeConfig } from "./auth-config";
import {
  PrincipalResolutionError,
  principalErrorResponse,
  requireUserPrincipal,
  resolveRequestPrincipal,
  usesAmbientCredential,
  type AnonymousPrincipal,
  type ApiKeyPrincipal,
  type UserPrincipal,
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

/**
 * Accepts a signed-in user or an `X-API-Key`, for REST endpoints that CI calls
 * as well as the dashboard. Returns the principal so the route can record who
 * called it.
 */
export async function authorizeUserOrApiKeyRequest(
  request: Request,
): Promise<
  { principal: UserPrincipal | ApiKeyPrincipal } | { response: Response }
> {
  const crossOrigin = crossOriginError(request);
  if (crossOrigin) return { response: crossOrigin };
  try {
    const principal = await resolveRequestPrincipal(request.headers);
    if (principal.kind === "user" || principal.kind === "apiKey") {
      return { principal };
    }
    return {
      response: principalErrorResponse(
        new PrincipalResolutionError(
          "A user session or X-API-Key is required.",
        ),
      ),
    };
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return { response: principalErrorResponse(error) };
    }
    throw error;
  }
}

/**
 * For endpoints anyone may call, such as crash ingestion from shipped apps: no
 * credential is anonymous, but a credential that is sent must be valid. A bad
 * key never falls back to anonymous access.
 */
export async function optionalUserOrApiKeyRequest(
  request: Request,
): Promise<
  | { principal: UserPrincipal | ApiKeyPrincipal | AnonymousPrincipal }
  | { response: Response }
> {
  const crossOrigin = crossOriginError(request);
  if (crossOrigin) return { response: crossOrigin };
  try {
    const principal = await resolveRequestPrincipal(request.headers);
    if (principal.kind === "agent") {
      return {
        response: principalErrorResponse(
          new PrincipalResolutionError(
            "Agent credentials are not accepted by this endpoint.",
          ),
        ),
      };
    }
    return { principal };
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return { response: principalErrorResponse(error) };
    }
    throw error;
  }
}
