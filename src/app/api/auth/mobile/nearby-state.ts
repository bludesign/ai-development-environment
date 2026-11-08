import "server-only";

import { originFromRequest } from "@/lib/app-origins";

export {
  createMobileOAuthState as createNearbyState,
  stateMatches,
} from "./oauth/state";

// A legacy OAuth flow cannot be changed into a TV flow by editing its return URL.
export const MOBILE_NEARBY_STATE_COOKIE = "aide-mobile-nearby-state";
const COOKIE_PATH = "/api/auth/mobile";

export function nearbyStateCookie(
  state: string,
  request: Request,
  trustProxyHeaders: boolean,
): string {
  return stateCookie(state, request, trustProxyHeaders, 10 * 60);
}

export function clearedNearbyStateCookie(
  request: Request,
  trustProxyHeaders: boolean,
): string {
  return stateCookie("", request, trustProxyHeaders, 0);
}

function stateCookie(
  state: string,
  request: Request,
  trustProxyHeaders: boolean,
  maxAge: number,
): string {
  const attributes = [
    `${MOBILE_NEARBY_STATE_COOKIE}=${state}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (originFromRequest(request, trustProxyHeaders)?.startsWith("https:")) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function readNearbyState(headers: Headers): string | null {
  for (const entry of (headers.get("cookie") ?? "").split(";")) {
    const separator = entry.indexOf("=");
    if (
      separator === -1 ||
      entry.slice(0, separator).trim() !== MOBILE_NEARBY_STATE_COOKIE
    )
      continue;
    return entry.slice(separator + 1).trim() || null;
  }
  return null;
}
