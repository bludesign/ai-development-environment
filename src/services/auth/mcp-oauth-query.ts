import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { getAuthRuntimeConfig } from "./auth-config";

export function oauthQueryString(
  query: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const entry of Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value])
      params.append(key, entry);
  }
  return params.toString();
}

export async function validMcpOAuthQuery(query: string): Promise<boolean> {
  return verifyOAuthQueryParams(query, getAuthRuntimeConfig().secret);
}

/** An existing session may still need reauthentication for this OAuth request. */
export function canContinueMcpAuthorization(
  query: string,
  sessionCreatedAt: Date,
): boolean {
  const params = new URLSearchParams(query);
  if (params.get("prompt")?.split(" ").includes("login")) return false;
  const maxAge = params.get("max_age");
  if (maxAge === null) return true;
  return (
    Number(maxAge) > 0 &&
    Date.now() - new Date(sessionCreatedAt).getTime() <= Number(maxAge) * 1000
  );
}

export function authorizationContinuation(query: string): string {
  const params = new URLSearchParams(query);
  for (const key of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"])
    params.delete(key);
  return `/api/auth/oauth2/authorize?${params}`;
}
