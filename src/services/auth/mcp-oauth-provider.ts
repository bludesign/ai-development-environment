import { randomUUID } from "node:crypto";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";

import type { getPrismaClient } from "@/data/prisma-client";
import { MCP_SCOPES } from "@/lib/mcp-scopes";
import type { McpOAuthConfig } from "./mcp-oauth-config";

type Database = Awaited<ReturnType<typeof getPrismaClient>>;
export const MCP_AUTHORIZATION_CLAIM = "aide_mcp_authorization_id";

function invalidGrant(): never {
  throw new APIError("BAD_REQUEST", {
    error: "invalid_grant",
    error_description:
      "The MCP authorization is inactive. Authorize this application again.",
  });
}

/** Runs after the provider has validated login, consent, client and resource.
 * Bind its code record to our immutable authorization id. The provider carries
 * referenceId through its own code exchange and every refresh rotation.
 */
export function mcpVerificationHook(prisma: Database, config: McpOAuthConfig) {
  return async (verification: { identifier: string; value: string }) => {
    let value;
    try {
      value = JSON.parse(verification.value);
    } catch {
      return;
    }
    if (value?.type !== "authorization_code") return;
    const resource = value.resource ?? value.query?.resource;
    if (
      !(Array.isArray(resource)
        ? resource.includes(config.resource)
        : resource === config.resource)
    )
      invalidGrant();
    if (
      typeof value.userId !== "string" ||
      typeof value.query?.client_id !== "string"
    )
      invalidGrant();
    const client = await prisma.oauthClient.findUnique({
      where: { clientId: value.query.client_id },
    });
    const authorization = await prisma.mcpAuthorization.create({
      data: {
        id: randomUUID(),
        authorizationCodeId: verification.identifier,
        userId: value.userId,
        clientId: value.query.client_id,
        clientName: client?.name ?? value.query.client_id,
        scopes: value.query.scope ?? "",
      },
    });
    return {
      data: {
        ...verification,
        value: JSON.stringify({ ...value, referenceId: authorization.id }),
      },
    };
  };
}

export function mcpAuthorizationClaims(
  prisma: Database,
  config: McpOAuthConfig,
) {
  return async ({
    user,
    client,
    referenceId,
    resources,
    scopes,
  }: OAuthClaimExtensionInput) => {
    if (!user || !referenceId || !resources?.includes(config.resource))
      invalidGrant();
    const authorization = await prisma.mcpAuthorization.findFirst({
      where: {
        id: referenceId,
        userId: user.id,
        clientId: client.clientId,
        revokedAt: null,
        user: { is: { id: user.id } },
      },
    });
    if (
      !authorization ||
      scopes.some((scope) => !authorization.scopes.split(" ").includes(scope))
    )
      invalidGrant();
    return { [MCP_AUTHORIZATION_CLAIM]: authorization.id };
  };
}

export function mcpOAuthPlugins(prisma: Database, config: McpOAuthConfig) {
  const scopes = [...MCP_SCOPES, "offline_access"];
  return [
    jwt({ jwt: { issuer: config.issuer, audience: config.resource } }),
    mcp({
      loginPage: "/mcp/sign-in",
      consentPage: "/mcp/consent",
      resource: config.resource,
      scopes,
      resources: [
        {
          identifier: config.resource,
          allowedScopes: scopes,
          accessTokenTtl: 300,
          refreshTokenTtl: 30 * 24 * 60 * 60,
        },
      ],
      grantTypes: ["authorization_code", "refresh_token"],
      accessTokenExpiresIn: 300,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      refreshTokenReuseInterval: 0,
      clientRegistrationDefaultScopes: ["mcp:read"],
      clientRegistrationAllowedScopes: scopes,
      allowDynamicClientRegistration: config.dcrEnabled,
      allowUnauthenticatedClientRegistration: config.dcrEnabled,
      clientRegistrationDefaultApplicationType: "infer",
      extensions: [
        { claims: { accessToken: mcpAuthorizationClaims(prisma, config) } },
      ],
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ];
}
