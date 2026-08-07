import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";

import { originFromRequest } from "@/lib/app-origins";

/**
 * One-flow state binding the mobile OAuth `start` and `complete` legs together.
 *
 * `complete` exchanges an existing browser session for a PKCE-bound authorization
 * code and hands it to a native app over a custom scheme. Without a state check,
 * the completion route is reachable by top-level navigation from any site —
 * `SameSite=Lax` sends the session cookie on exactly that kind of request — so
 * a hostile page could make a signed-in user's browser mint a code and fire it
 * at whatever holds the `aide-auth://`
 * scheme on that device. Requiring a value this server planted moments earlier
 * means only a flow that actually began at `start` can finish.
 *
 * The cookie is scoped to the mobile routes, is `HttpOnly` so page script cannot
 * read or forge it, and stays `Lax` because the return leg of the OAuth round trip
 * is a top-level navigation from the identity provider.
 */
export const MOBILE_OAUTH_STATE_COOKIE = "aide-mobile-oauth-state";
const STATE_TTL_SECONDS = 10 * 60;
const COOKIE_PATH = "/api/auth/mobile";

export function createMobileOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

function isSecureRequest(
  request: Request,
  trustProxyHeaders: boolean,
): boolean {
  return (
    originFromRequest(request, trustProxyHeaders)?.startsWith("https:") ?? false
  );
}

export function mobileOAuthStateCookie(
  state: string,
  request: Request,
  trustProxyHeaders: boolean,
): string {
  const attributes = [
    `${MOBILE_OAUTH_STATE_COOKIE}=${state}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${STATE_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(request, trustProxyHeaders)) attributes.push("Secure");
  return attributes.join("; ");
}

/** Expires the cookie so a state cannot be replayed after one completion. */
export function clearedMobileOAuthStateCookie(
  request: Request,
  trustProxyHeaders: boolean,
): string {
  const attributes = [
    `${MOBILE_OAUTH_STATE_COOKIE}=`,
    `Path=${COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(request, trustProxyHeaders)) attributes.push("Secure");
  return attributes.join("; ");
}

export function readMobileOAuthState(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const entry of cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() !== MOBILE_OAUTH_STATE_COOKIE)
      continue;
    return entry.slice(separator + 1).trim() || null;
  }
  return null;
}

export function stateMatches(
  expected: string | null,
  supplied: string | null,
): boolean {
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
