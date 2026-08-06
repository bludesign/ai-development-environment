"use client";

import {
  createClient,
  type Client,
  type FormattedExecutionResult,
  type Sink,
  type SubscribePayload,
} from "graphql-ws";

type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> };

const MAX_CONCURRENT_REQUESTS = 6;
const REQUEST_TIMEOUT_MS = 60_000;

let activeRequests = 0;
const requestQueue: Array<() => void> = [];
const inFlightQueries = new Map<string, Promise<unknown>>();

function scheduleRequest<T>(request: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeRequests += 1;
      void request()
        .then(resolve, reject)
        .finally(() => {
          activeRequests -= 1;
          requestQueue.shift()?.();
        });
    };

    if (activeRequests < MAX_CONCURRENT_REQUESTS) run();
    else requestQueue.push(run);
  });
}

function isQuery(operation: string): boolean {
  const withoutLeadingComments = operation.replace(
    /^(?:\s+|#[^\r\n]*(?:\r?\n|$))*/,
    "",
  );
  return !/^mutation\b/i.test(withoutLeadingComments);
}

async function executeRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body: GraphQLResponse<T> | undefined;
    try {
      body = raw ? (JSON.parse(raw) as GraphQLResponse<T>) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok || body?.errors?.length || !body?.data) {
      const detail =
        body?.errors?.map((error) => error.message).join("; ") ||
        `HTTP ${response.status} ${response.statusText}`.trim();
      throw new Error(
        !body && raw ? `${detail}: ${raw.slice(0, 500)}` : detail,
      );
    }
    return body.data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("The GraphQL request timed out.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function controlPlaneRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!isQuery(query))
    return scheduleRequest(() => executeRequest(query, variables));

  const key = JSON.stringify([query, variables ?? null]);
  const existing = inFlightQueries.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = scheduleRequest(() => executeRequest<T>(query, variables));
  inFlightQueries.set(key, request);
  void request
    .finally(() => inFlightQueries.delete(key))
    .catch(() => undefined);
  return request;
}

let subscriptionClient: Client | null = null;
let subscriptionFacade: Pick<Client, "subscribe"> | null = null;
const connectionListeners = new Set<() => void>();
let lastAuthenticationTerminationAt = Number.NEGATIVE_INFINITY;

const AUTHENTICATION_RETRY_BASE_MS = 1_000;
const AUTHENTICATION_RETRY_MAX_MS = 30_000;
const AUTHENTICATION_TERMINATION_COOLDOWN_MS = 250;

export function onControlPlaneConnected(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

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

function subscriptionErrorMessages(error: unknown): string[] {
  if (error instanceof Error) return [error.message];
  if (Array.isArray(error)) {
    return error.flatMap((entry) => subscriptionErrorMessages(entry));
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? [message] : [];
  }
  return typeof error === "string" ? [error] : [];
}

export function isControlPlaneAuthenticationError(error: unknown): boolean {
  return subscriptionErrorMessages(error).some(
    (message) =>
      message.includes("Authentication is required") ||
      message.includes("supplied credential is invalid") ||
      message.includes("session is invalid or expired"),
  );
}

function rawSubscriptionClient(): Client {
  subscriptionClient ??= createClient({
    url: websocketUrl,
    lazy: true,
    retryAttempts: Infinity,
    shouldRetry: () => true,
    on: {
      connected: () => {
        for (const listener of connectionListeners) listener();
      },
    },
  });
  return subscriptionClient;
}

function terminateForAuthenticationRecovery(client: Client): void {
  const now = Date.now();
  if (
    now - lastAuthenticationTerminationAt <
    AUTHENTICATION_TERMINATION_COOLDOWN_MS
  ) {
    return;
  }
  lastAuthenticationTerminationAt = now;
  // A WebSocket handshake captures its cookie headers once. Terminating the
  // shared connection lets graphql-ws reconnect with the current session while
  // its other active subscriptions retry automatically.
  client.terminate();
}

function resilientSubscribe<
  Data = Record<string, unknown>,
  Extensions = unknown,
>(
  payload: SubscribePayload,
  sink: Sink<FormattedExecutionResult<Data, Extensions>>,
): () => void {
  let disposed = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeCurrent: (() => void) | null = null;

  const subscribe = () => {
    if (disposed) return;
    const client = rawSubscriptionClient();
    disposeCurrent = client.subscribe<Data, Extensions>(payload, {
      next(value) {
        retries = 0;
        sink.next(value);
      },
      error(error) {
        if (disposed) return;
        if (!isControlPlaneAuthenticationError(error)) {
          disposed = true;
          sink.error(error);
          return;
        }

        disposeCurrent?.();
        disposeCurrent = null;
        terminateForAuthenticationRecovery(client);
        const delay = Math.min(
          AUTHENTICATION_RETRY_MAX_MS,
          AUTHENTICATION_RETRY_BASE_MS * 2 ** Math.min(retries, 5),
        );
        retries += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          subscribe();
        }, delay);
      },
      complete() {
        if (disposed) return;
        disposed = true;
        sink.complete();
      },
    });
  };

  subscribe();
  return () => {
    disposed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    disposeCurrent?.();
  };
}

export function controlPlaneSubscriptions(): Pick<Client, "subscribe"> {
  subscriptionFacade ??= { subscribe: resilientSubscribe };
  return subscriptionFacade;
}
