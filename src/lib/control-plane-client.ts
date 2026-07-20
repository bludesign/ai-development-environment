"use client";

import { createClient, type Client } from "graphql-ws";

type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> };

export async function controlPlaneRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as GraphQLResponse<T>;
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(
      body.errors?.map((error) => error.message).join("; ") ||
        `HTTP ${response.status}`,
    );
  }
  return body.data;
}

let subscriptionClient: Client | null = null;

export function resolveControlPlaneWebSocketUrl(
  configured: string | undefined,
  pageProtocol: "http:" | "https:",
  pageHost: string,
): string {
  const sameOrigin = `${pageProtocol === "https:" ? "wss" : "ws"}://${pageHost}/graphql`;
  if (!configured) return sameOrigin;
  try {
    const configuredUrl = new URL(configured);
    if (pageProtocol === "https:" && configuredUrl.protocol !== "wss:") {
      return sameOrigin;
    }
  } catch {
    // Let graphql-ws report malformed explicitly configured URLs.
  }
  return configured;
}

function websocketUrl(): string {
  return resolveControlPlaneWebSocketUrl(
    process.env.NEXT_PUBLIC_AGENT_WS_URL,
    window.location.protocol as "http:" | "https:",
    window.location.host,
  );
}

export function controlPlaneSubscriptions(): Client {
  subscriptionClient ??= createClient({
    url: websocketUrl,
    lazy: true,
    retryAttempts: Infinity,
    shouldRetry: () => true,
  });
  return subscriptionClient;
}
