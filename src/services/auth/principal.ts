import "server-only";

import type { AgentControlService } from "@/services/agent-control";

import { getAuth } from "./auth";

export type UserPrincipal = {
  kind: "user";
  userId: string;
  email: string;
  sessionId: string;
};

export type ApiKeyPrincipal = {
  kind: "apiKey";
  apiKeyId: string;
  userId: string;
  name: string | null;
};

export type AgentPrincipal = { kind: "agent"; agentId: string };
export type AnonymousPrincipal = { kind: "anonymous" };

export type RequestPrincipal =
  UserPrincipal | ApiKeyPrincipal | AgentPrincipal | AnonymousPrincipal;

export class PrincipalResolutionError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "PrincipalResolutionError";
  }
}

function bearerCredential(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) return null;
  if (!authorization.startsWith("Bearer ")) {
    throw new PrincipalResolutionError(
      "Authorization must use the Bearer scheme.",
    );
  }
  const value = authorization.slice("Bearer ".length).trim();
  if (!value) {
    throw new PrincipalResolutionError("The bearer credential is empty.");
  }
  return value;
}

function hasBetterAuthCookie(headers: Headers): boolean {
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(
    headers.get("cookie") ?? "",
  );
}

export async function resolveRequestPrincipal(
  headers: Headers,
  agents?: AgentControlService,
): Promise<RequestPrincipal> {
  const apiKey = headers.get("x-api-key")?.trim() || null;
  const bearer = bearerCredential(headers);
  const hasSessionCookie = hasBetterAuthCookie(headers);

  const credentialCount =
    Number(Boolean(apiKey)) +
    Number(Boolean(bearer)) +
    Number(hasSessionCookie);
  if (credentialCount > 1) {
    throw new PrincipalResolutionError(
      "Provide exactly one application credential.",
      400,
    );
  }

  if (apiKey) {
    const auth = await getAuth();
    const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
    if (!result.valid || !result.key) {
      throw new PrincipalResolutionError("The API key is invalid or inactive.");
    }
    return {
      kind: "apiKey",
      apiKeyId: result.key.id,
      userId: result.key.referenceId,
      name: result.key.name ?? null,
    };
  }

  if (bearer?.startsWith("agent_")) {
    if (!agents) {
      throw new PrincipalResolutionError(
        "Agent credentials are not accepted by this endpoint.",
      );
    }
    const agentId = await agents.authenticate(bearer);
    if (!agentId) {
      throw new PrincipalResolutionError("The agent credential is invalid.");
    }
    return { kind: "agent", agentId };
  }

  if (bearer || hasSessionCookie) {
    const auth = await getAuth();
    const result = await auth.api.getSession({ headers });
    if (!result?.session || !result.user) {
      throw new PrincipalResolutionError("The session is invalid or expired.");
    }
    return {
      kind: "user",
      userId: result.user.id,
      email: result.user.email,
      sessionId: result.session.id,
    };
  }

  return { kind: "anonymous" };
}

export function principalErrorResponse(
  error: PrincipalResolutionError,
): Response {
  return Response.json(
    { error: { code: "AUTHENTICATION_REQUIRED", message: error.message } },
    {
      status: error.status,
      headers: { "www-authenticate": "Bearer" },
    },
  );
}

export async function requireUserPrincipal(
  headers: Headers,
): Promise<UserPrincipal> {
  const principal = await resolveRequestPrincipal(headers);
  if (principal.kind !== "user") {
    throw new PrincipalResolutionError("A user session is required.");
  }
  return principal;
}
