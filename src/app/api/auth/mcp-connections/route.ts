import { getPrismaClient } from "@/data/prisma-client";
import { disconnectMcpClient } from "@/services/auth/mcp-oauth";
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
        clientId: true,
        clientName: true,
        scopes: true,
        createdAt: true,
      },
    });
    const clients = new Map<
      string,
      { clientId: string; name: string; scopes: string[]; connectedAt: string }
    >();
    for (const authorization of authorizations) {
      const client = clients.get(authorization.clientId);
      const scopes = authorization.scopes.split(/\s+/).filter(Boolean);
      if (client) client.scopes = [...new Set([...client.scopes, ...scopes])];
      else
        clients.set(authorization.clientId, {
          clientId: authorization.clientId,
          name: authorization.clientName,
          scopes,
          connectedAt: authorization.createdAt.toISOString(),
        });
    }
    return {
      enabled: Boolean(getMcpOAuthConfig()),
      clients: [...clients.values()],
    };
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function DELETE(request: Request): Promise<Response> {
  const response = await authenticated(request, async (principal) => {
    const { clientId } = z
      .object({ clientId: z.string().min(1).max(2048) })
      .parse(await request.json());
    await disconnectMcpClient(principal.userId, clientId);
    return { disconnected: true };
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
