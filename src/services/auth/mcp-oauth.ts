import "server-only";

import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { createDpopReplayStore } from "better-auth/oauth2";
import type { JWTPayload } from "jose";

import { getPrismaClient } from "@/data/prisma-client";
import { getAuth } from "./auth";
import { getMcpOAuthConfig } from "./mcp-oauth-config";
import { MCP_AUTHORIZATION_CLAIM } from "./mcp-oauth-provider";
import { assertSingleCredential } from "./principal";

export type McpOAuthPrincipal = {
  kind: "mcpOAuth";
  userId: string;
  clientId: string;
  authorizationId: string;
  scopes: readonly string[];
};

/** Session bearer values are opaque; JWTs and DPoP are always OAuth credentials.
 * This is routing only. No identity is derived from an unverified token.
 */
export function isMcpOAuthCredential(headers: Headers): boolean {
  const authorization = headers.get("authorization") ?? "";
  return (
    /^DPoP /i.test(authorization) ||
    /^Bearer [^\s.]+\.[^\s.]+\.[^\s.]+$/i.test(authorization)
  );
}

export function mcpOAuthChallenge(
  status = 401,
  scopes: readonly string[] = ["mcp:read"],
): Response {
  const config = getMcpOAuthConfig();
  const metadata = config
    ? `, resource_metadata="${config.origin}/.well-known/oauth-protected-resource/api/mcp"`
    : "";
  return Response.json(
    {
      error: {
        code:
          status === 403 ? "INSUFFICIENT_SCOPE" : "MCP_AUTHENTICATION_REQUIRED",
        message:
          status === 403
            ? "Additional MCP permissions are required"
            : "MCP authorization is required",
      },
    },
    {
      status,
      headers: {
        "www-authenticate": `Bearer${status === 403 ? ' error="insufficient_scope",' : ""} scope="${scopes.join(" ")}"${metadata}`,
        "cache-control": "no-store",
      },
    },
  );
}

/** No revocation cache: this query runs for every request and again at dispatch. */
export async function activeMcpAuthorization(
  principal: McpOAuthPrincipal,
): Promise<boolean> {
  const prisma = await getPrismaClient();
  const authorization = await prisma.mcpAuthorization.findFirst({
    where: {
      id: principal.authorizationId,
      userId: principal.userId,
      clientId: principal.clientId,
      revokedAt: null,
      user: { is: { id: principal.userId } },
    },
  });
  return Boolean(
    authorization &&
    principal.scopes.every((scope) =>
      authorization.scopes.split(" ").includes(scope),
    ),
  );
}

export async function principalFromMcpClaims(
  claims: JWTPayload,
): Promise<McpOAuthPrincipal | null> {
  const authorizationId = claims[MCP_AUTHORIZATION_CLAIM];
  const clientId = claims.client_id ?? claims.azp;
  if (
    typeof claims.sub !== "string" ||
    typeof clientId !== "string" ||
    typeof authorizationId !== "string" ||
    typeof claims.scope !== "string" ||
    (claims.client_id && claims.azp && claims.client_id !== claims.azp)
  )
    return null;
  const principal: McpOAuthPrincipal = {
    kind: "mcpOAuth",
    userId: claims.sub,
    clientId,
    authorizationId,
    scopes: claims.scope.split(/\s+/).filter(Boolean),
  };
  return (await activeMcpAuthorization(principal)) ? principal : null;
}

export async function authorizeMcpOAuthRequest(
  request: Request,
): Promise<{ principal: McpOAuthPrincipal } | { response: Response }> {
  assertSingleCredential(request.headers);
  const config = getMcpOAuthConfig();
  if (!config) return { response: mcpOAuthChallenge() };
  let principal: McpOAuthPrincipal | null = null;
  const auth = await getAuth();
  const { internalAdapter } = await auth.$context;
  // Browser authentication resolves its base URL per request. Token validation
  // always uses the configured canonical OAuth identity, including DPoP replay
  // protection backed by the shared database.
  const response = await createMcpProtectedRequestHandler(
    {
      audience: config.resource,
      issuer: config.issuer,
      jwksUrl: `${config.issuer}/jwks`,
      jwtVerifyOptions: { requiredClaims: ["azp"] },
      requiredScopes: ["mcp:read"],
      dpop: { replayStore: createDpopReplayStore(internalAdapter) },
    },
    async (_request, claims) => {
      principal = await principalFromMcpClaims(claims);
      return principal
        ? new Response(null, { status: 204 })
        : mcpOAuthChallenge();
    },
  )(request);
  return principal ? { principal } : { response };
}

/** Revoke one generation, retaining other approvals for this user/client. */
export async function revokeMcpAuthorization(
  userId: string,
  clientId: string,
  authorizationId: string,
): Promise<boolean> {
  const prisma = await getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const authorization = await tx.mcpAuthorization.findFirst({
      where: { id: authorizationId, userId, clientId },
      select: { id: true, authorizationCodeId: true },
    });
    if (!authorization) return false;
    await tx.mcpAuthorization.updateMany({
      where: { id: authorization.id, userId, clientId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const credentials = {
      userId,
      clientId,
      OR: [
        { referenceId: authorization.id },
        { authorizationCodeId: authorization.authorizationCodeId },
      ],
    };
    await tx.oauthAccessToken.deleteMany({ where: credentials });
    await tx.oauthRefreshToken.deleteMany({ where: credentials });
    const remaining = await tx.mcpAuthorization.findFirst({
      where: { userId, clientId, revokedAt: null },
      select: { id: true },
    });
    if (!remaining)
      await tx.oauthConsent.deleteMany({ where: { userId, clientId } });
    return true;
  });
}

/** Disconnect all generations for this user/client; future consent gets fresh ids. */
export async function disconnectMcpClient(
  userId: string,
  clientId: string,
): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.$transaction(async (tx) => {
    await tx.mcpAuthorization.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.oauthRefreshToken.deleteMany({ where: { userId, clientId } });
    await tx.oauthAccessToken.deleteMany({ where: { userId, clientId } });
    await tx.oauthConsent.deleteMany({ where: { userId, clientId } });
  });
}
