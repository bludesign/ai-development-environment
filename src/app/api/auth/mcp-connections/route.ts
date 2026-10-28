import { APIError } from "better-auth/api";
import { getPrismaClient } from "@/data/prisma-client";
import type {
  McpConnection,
  McpConnectionsResponse,
} from "@/lib/mcp-connections";
import {
  disconnectMcpClient,
  revokeMcpAuthorization,
} from "@/services/auth/mcp-oauth";
import { getMcpOAuthConfig } from "@/services/auth/mcp-oauth-config";
import { authenticated } from "../management/http";
import * as z from "zod/v4";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const response = await authenticated(request, async (principal) => {
    const prisma = await getPrismaClient();
    const authorizations = await prisma.mcpAuthorization.findMany({
      where: { userId: principal.userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        clientId: true,
        clientName: true,
        scopes: true,
        createdAt: true,
      },
    });
    const clients = new Map<string, McpConnection>();
    for (const authorization of authorizations) {
      const client = clients.get(authorization.clientId);
      const scopes = authorization.scopes.split(/\s+/).filter(Boolean);
      const detail = {
        id: authorization.id,
        authorizedAt: authorization.createdAt.toISOString(),
        scopes,
      };
      if (client) {
        client.scopes = [...new Set([...client.scopes, ...scopes])];
        client.firstAuthorizedAt = authorization.createdAt.toISOString();
        client.authorizationCount += 1;
        client.authorizations.push(detail);
      } else
        clients.set(authorization.clientId, {
          clientId: authorization.clientId,
          name: authorization.clientName,
          scopes,
          connectedAt: authorization.createdAt.toISOString(),
          firstAuthorizedAt: authorization.createdAt.toISOString(),
          authorizationCount: 1,
          authorizations: [detail],
        });
    }
    return {
      enabled: Boolean(getMcpOAuthConfig()),
      clients: [...clients.values()],
    } satisfies McpConnectionsResponse;
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function DELETE(request: Request): Promise<Response> {
  const response = await authenticated(request, async (principal) => {
    const { clientId, authorizationId } = z
      .strictObject({
        clientId: z.string().min(1).max(2048),
        authorizationId: z.string().min(1).max(128).optional(),
      })
      .parse(await request.json());
    if (authorizationId !== undefined) {
      const revoked = await revokeMcpAuthorization(
        principal.userId,
        clientId,
        authorizationId,
      );
      if (!revoked)
        throw new APIError("NOT_FOUND", {
          message: "Authorization not found.",
        });
      return { revoked: true };
    }
    await disconnectMcpClient(principal.userId, clientId);
    return { disconnected: true };
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
