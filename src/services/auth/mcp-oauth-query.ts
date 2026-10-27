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

export function authorizationContinuation(query: string): string {
  const params = new URLSearchParams(query);
  for (const key of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"])
    params.delete(key);
  return `/api/auth/oauth2/authorize?${params}`;
}
