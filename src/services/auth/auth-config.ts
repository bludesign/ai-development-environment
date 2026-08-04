import type { AppOrigins } from "@/lib/app-origins";
import { resolveAppOrigins } from "@/lib/app-origins";
import { getAppSecrets } from "@/lib/app-secret";

export type AuthMode = "password" | "oidc" | "both";

export type OAuthProviderConfig = {
  providerId: string;
  displayName: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  discoveryUrl?: string;
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
};

export type AuthRuntimeConfig = {
  secret: string;
  /** The full allowlist; Better Auth resolves its base URL per request from it. */
  origins: AppOrigins;
  /**
   * Canonical absolute origin, for links built without a request in hand. Routes
   * that do have a request should prefer its origin when the allowlist trusts it.
   *
   * `null` when nothing was configured — there is then no address to use except
   * the one on the request being handled.
   */
  baseURL: string | null;
  /** Whether `x-forwarded-host`/`x-forwarded-proto` may be believed. */
  trustProxyHeaders: boolean;
  mode: AuthMode;
  provider: OAuthProviderConfig | null;
};

type AuthEnvironment = {
  readonly [name: string]: string | undefined;
};

function value(environment: AuthEnvironment, name: string): string | undefined {
  const configured = environment[name]?.trim();
  return configured ? configured : undefined;
}

function required(environment: AuthEnvironment, name: string): string {
  const configured = value(environment, name);
  if (!configured) throw new Error(`${name} is required for AUTH_MODE.`);
  return configured;
}

/**
 * Forwarded headers are client-controlled unless something in front strips them,
 * so believing them is opt-in rather than inferred from the deployment shape.
 */
function trustProxyHeaders(environment: AuthEnvironment): boolean {
  const configured = value(environment, "TRUST_PROXY_HEADERS")?.toLowerCase();
  if (!configured || configured === "false" || configured === "0") return false;
  if (configured === "true" || configured === "1") return true;
  throw new Error("TRUST_PROXY_HEADERS must be true, false, 1, or 0.");
}

function authMode(environment: AuthEnvironment): AuthMode {
  const configured = value(environment, "AUTH_MODE") ?? "password";
  if (
    configured !== "password" &&
    configured !== "oidc" &&
    configured !== "both"
  ) {
    throw new Error('AUTH_MODE must be "password", "oidc", or "both".');
  }
  return configured;
}

function oauthProvider(
  environment: AuthEnvironment,
  mode: AuthMode,
): OAuthProviderConfig | null {
  if (mode === "password") return null;

  const discoveryUrl = value(environment, "AUTH_OAUTH_DISCOVERY_URL");
  const authorizationUrl = value(environment, "AUTH_OAUTH_AUTHORIZATION_URL");
  const tokenUrl = value(environment, "AUTH_OAUTH_TOKEN_URL");
  const userInfoUrl = value(environment, "AUTH_OAUTH_USER_INFO_URL");
  const issuer = value(environment, "AUTH_OAUTH_ISSUER");
  const anyExplicitEndpoint = Boolean(
    authorizationUrl || tokenUrl || userInfoUrl,
  );
  const explicitEndpoints = authorizationUrl && tokenUrl && userInfoUrl;

  if (discoveryUrl && anyExplicitEndpoint) {
    throw new Error(
      "OIDC configuration must use either discovery or explicit endpoints, not both.",
    );
  }
  if (!discoveryUrl && !explicitEndpoints) {
    throw new Error(
      "OIDC authentication requires AUTH_OAUTH_DISCOVERY_URL or all of AUTH_OAUTH_AUTHORIZATION_URL, AUTH_OAUTH_TOKEN_URL, and AUTH_OAUTH_USER_INFO_URL.",
    );
  }
  if (anyExplicitEndpoint && !explicitEndpoints) {
    throw new Error(
      "Explicit OAuth configuration must include authorization, token, and user-info URLs.",
    );
  }
  if (explicitEndpoints && !issuer) {
    throw new Error(
      "AUTH_OAUTH_ISSUER is required with explicit OAuth endpoints.",
    );
  }

  const scopes = required(environment, "AUTH_OAUTH_SCOPES")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
    throw new Error("AUTH_OAUTH_SCOPES must contain at least one scope.");
  }

  return {
    providerId: required(environment, "AUTH_OAUTH_PROVIDER_ID"),
    displayName: required(environment, "AUTH_OAUTH_PROVIDER_NAME"),
    clientId: required(environment, "AUTH_OAUTH_CLIENT_ID"),
    clientSecret: required(environment, "AUTH_OAUTH_CLIENT_SECRET"),
    scopes,
    discoveryUrl,
    issuer,
    authorizationUrl,
    tokenUrl,
    userInfoUrl,
  };
}

export function getAuthRuntimeConfig(
  environment: AuthEnvironment = process.env,
): AuthRuntimeConfig {
  const mode = authMode(environment);
  const origins = resolveAppOrigins(environment);
  return {
    secret: getAppSecrets(environment).authSecret,
    origins,
    baseURL: origins.canonical,
    trustProxyHeaders: trustProxyHeaders(environment),
    mode,
    provider: oauthProvider(environment, mode),
  };
}

export function passwordAuthenticationEnabled(mode: AuthMode): boolean {
  return mode === "password" || mode === "both";
}

export function oauthAuthenticationEnabled(mode: AuthMode): boolean {
  return mode === "oidc" || mode === "both";
}
