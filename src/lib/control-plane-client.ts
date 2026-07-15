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

function websocketUrl(): string {
  const configured = process.env.NEXT_PUBLIC_AGENT_WS_URL;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:3091/graphql`;
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
