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
type SharedQuery = {
  controller: AbortController;
  promise: Promise<unknown>;
  consumers: number;
  settled: boolean;
};
const inFlightQueries = new Map<string, SharedQuery>();

export type ControlPlaneRequestOptions = {
  signal?: AbortSignal;
  /** Opt in only for disposable work: cancel while queued, never after dispatch. */
  cancelBeforeDispatch?: boolean;
};

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The request was aborted.", "AbortError")
  );
}

function scheduleRequest<T>(
  request: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abortQueued = () => {
      const index = requestQueue.indexOf(run);
      if (index >= 0) requestQueue.splice(index, 1);
      signal?.removeEventListener("abort", abortQueued);
      reject(abortReason(signal!));
    };
    const run = () => {
      signal?.removeEventListener("abort", abortQueued);
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      activeRequests += 1;
      const finish = () => {
        activeRequests -= 1;
        requestQueue.shift()?.();
      };
      void request().then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    };

    if (signal?.aborted) reject(abortReason(signal));
    else if (activeRequests < MAX_CONCURRENT_REQUESTS) run();
    else {
      requestQueue.push(run);
      signal?.addEventListener("abort", abortQueued, { once: true });
    }
  });
}

function operationKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }
    return entry;
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
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
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
    if (timedOut) {
      throw new Error("The GraphQL request timed out.", { cause: error });
    }
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function consumeQuery<T>(
  key: string,
  shared: SharedQuery,
  signal?: AbortSignal,
): Promise<T> {
  shared.consumers += 1;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      shared.consumers -= 1;
      signal?.removeEventListener("abort", abort);
      return true;
    };
    const abort = () => {
      if (!release()) return;
      reject(abortReason(signal!));
      if (shared.consumers === 0 && !shared.settled) {
        // Remove immediately so a new consumer can start a fresh request even
        // before the canceled fetch's rejection has reached its cleanup.
        if (inFlightQueries.get(key) === shared) inFlightQueries.delete(key);
        shared.controller.abort();
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    void shared.promise.then(
      (value) => {
        if (release()) resolve(value as T);
      },
      (error: unknown) => {
        if (release()) reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}

const mutationListeners = new Set<(operation: string) => void>();

/** Local mutation invalidation receives the operation document, without variables. */
export function onControlPlaneMutation(
  listener: (operation: string) => void,
): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export async function controlPlaneRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
  options?: ControlPlaneRequestOptions,
): Promise<T> {
  // Accepted writes always finish. Disposable inspection jobs may explicitly
  // cancel before dispatch; ordinary mutations retain their queue semantics.
  if (!isQuery(query)) {
    const data = await scheduleRequest<T>(
      () => executeRequest(query, variables),
      options?.cancelBeforeDispatch ? options.signal : undefined,
    );
    // A failed invalidation consumer must not turn a successful write into an
    // apparent mutation failure or invite a duplicate write.
    for (const listener of [...mutationListeners]) {
      try {
        listener(query);
      } catch {
        /* Other consumers still invalidate. */
      }
    }
    return data;
  }

  if (options?.signal?.aborted) throw abortReason(options.signal);
  const key = operationKey([query, variables ?? null]);
  let shared = inFlightQueries.get(key);
  if (!shared) {
    const controller = new AbortController();
    const entry: SharedQuery = {
      controller,
      consumers: 0,
      settled: false,
      promise: scheduleRequest(
        () => executeRequest<T>(query, variables, controller.signal),
        controller.signal,
      ),
    };
    inFlightQueries.set(key, entry);
    const cleanup = () => {
      entry.settled = true;
      if (inFlightQueries.get(key) === entry) inFlightQueries.delete(key);
    };
    void entry.promise.then(cleanup, cleanup);
    shared = entry;
  }
  return consumeQuery<T>(key, shared, options?.signal);
}

let subscriptionClient: Client | null = null;
let subscriptionFacade: Pick<Client, "subscribe"> | null = null;
const connectionListeners = new Set<() => void>();
export type ControlPlaneRecovery = { initialConnection: boolean };
const recoveryListeners = new Set<(event?: ControlPlaneRecovery) => void>();
const initialRecoveryListeners = new Set<
  (event?: ControlPlaneRecovery) => void
>();
let hasConnected = false;
let lastAuthenticationTerminationAt = Number.NEGATIVE_INFINITY;

const SUBSCRIPTION_RETRY_BASE_MS = 1_000;
const SUBSCRIPTION_RETRY_MAX_MS = 30_000;
const AUTHENTICATION_TERMINATION_COOLDOWN_MS = 250;

export function onControlPlaneConnected(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/**
 * Invalidates snapshots after a socket reconnect or an operation retry. Initial
 * page reads are owned by their components; includeInitial preserves callers
 * that already reconciled on the first connection. The
 * protocol has no per-operation registration acknowledgement: this is a prompt
 * to reconcile missed events, not proof that fallback recovery can be removed.
 */
export function onControlPlaneRecovery(
  listener: (event?: ControlPlaneRecovery) => void,
  { includeInitial = false }: { includeInitial?: boolean } = {},
): () => void {
  recoveryListeners.add(listener);
  if (includeInitial) initialRecoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
    initialRecoveryListeners.delete(listener);
  };
}

function notifyListeners(listeners: Iterable<() => void>): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // One consumer's callback must not suppress another consumer's recovery.
      if (typeof globalThis.reportError === "function")
        globalThis.reportError(error);
      else console.error("Control plane recovery listener failed.", error);
    }
  }
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
  return (
    subscriptionErrorCodes(error).includes("UNAUTHENTICATED") ||
    subscriptionErrorMessages(error).some(
      (message) =>
        message.includes("Authentication is required") ||
        message.includes("supplied credential is invalid") ||
        message.includes("session is invalid or expired"),
    )
  );
}

function subscriptionErrorCodes(error: unknown): string[] {
  if (Array.isArray(error)) return error.flatMap(subscriptionErrorCodes);
  if (!error || typeof error !== "object" || !("extensions" in error))
    return [];
  const extensions = error.extensions;
  if (!extensions || typeof extensions !== "object" || !("code" in extensions))
    return [];
  return typeof extensions.code === "string" ? [extensions.code] : [];
}

function isPermanentSubscriptionError(error: unknown): boolean {
  const terminalCodes = new Set([
    "GRAPHQL_PARSE_FAILED",
    "GRAPHQL_VALIDATION_FAILED",
    "BAD_USER_INPUT",
    "FORBIDDEN",
  ]);
  return (
    subscriptionErrorCodes(error).some((code) => terminalCodes.has(code)) ||
    subscriptionErrorMessages(error).some((message) =>
      /Cannot query field|Syntax Error|Unknown (?:argument|type|operation)|Must provide operation name|Variable .+ (?:invalid value|was not provided)|must select only one top level field/i.test(
        message,
      ),
    )
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
        const event = { initialConnection: !hasConnected };
        hasConnected = true;
        notifyListeners([
          ...connectionListeners,
          ...[...recoveryListeners]
            .filter(
              (listener) =>
                !connectionListeners.has(listener) &&
                (!event.initialConnection ||
                  initialRecoveryListeners.has(listener)),
            )
            .map((listener) => () => listener(event)),
        ]);
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
  let generation = 0;

  const subscribe = (recovering = false) => {
    if (disposed) return;
    const client = rawSubscriptionClient();
    const attempt = ++generation;
    const disposeAttempt = client.subscribe<Data, Extensions>(payload, {
      next(value) {
        if (disposed || generation !== attempt) return;
        retries = 0;
        sink.next(value);
      },
      error(error) {
        if (disposed || generation !== attempt) return;
        generation += 1;
        if (
          isPermanentSubscriptionError(error) &&
          !isControlPlaneAuthenticationError(error)
        ) {
          disposed = true;
          disposeCurrent?.();
          disposeCurrent = null;
          sink.error(error);
          return;
        }

        disposeCurrent?.();
        disposeCurrent = null;
        // Operation errors terminate only this operation in graphql-ws. Retry
        // transient failures without disrupting unrelated healthy operations.
        if (isControlPlaneAuthenticationError(error))
          terminateForAuthenticationRecovery(client);
        const delay = Math.min(
          SUBSCRIPTION_RETRY_MAX_MS,
          SUBSCRIPTION_RETRY_BASE_MS * 2 ** Math.min(retries, 5),
        );
        retries += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          subscribe(true);
        }, delay);
      },
      complete() {
        if (disposed || generation !== attempt) return;
        generation += 1;
        disposed = true;
        sink.complete();
      },
    });
    if (disposed || generation !== attempt) disposeAttempt();
    else {
      disposeCurrent = disposeAttempt;
      if (recovering) notifyListeners(recoveryListeners);
    }
  };

  subscribe();
  return () => {
    disposed = true;
    generation += 1;
    if (retryTimer !== null) clearTimeout(retryTimer);
    disposeCurrent?.();
  };
}

type SharedSubscriptionSink = Sink<FormattedExecutionResult<unknown, unknown>>;
type SharedSubscription = {
  sinks: Set<SharedSubscriptionSink>;
  dispose: () => void;
};
const sharedSubscriptions = new Map<string, SharedSubscription>();

function sharedSubscribe<Data = Record<string, unknown>, Extensions = unknown>(
  payload: SubscribePayload,
  sink: Sink<FormattedExecutionResult<Data, Extensions>>,
): () => void {
  const key = operationKey(payload);
  // A caller may intentionally reuse the same sink object for two independent
  // subscriptions. Give each registration its own lifetime and delivery.
  const consumer: SharedSubscriptionSink = {
    next: (value) =>
      sink.next(value as FormattedExecutionResult<Data, Extensions>),
    error: (error) => sink.error(error),
    complete: () => sink.complete(),
  };
  let shared = sharedSubscriptions.get(key);
  if (!shared) {
    const entry: SharedSubscription = {
      sinks: new Set([consumer]),
      dispose: () => undefined,
    };
    sharedSubscriptions.set(key, entry);
    const finish = () => {
      if (sharedSubscriptions.get(key) === entry)
        sharedSubscriptions.delete(key);
      const sinks = [...entry.sinks];
      entry.sinks.clear();
      return sinks;
    };
    entry.dispose = resilientSubscribe(payload, {
      next(value) {
        notifyListeners(
          [...entry.sinks].map((current) => () => current.next(value)),
        );
      },
      error(error) {
        notifyListeners(finish().map((current) => () => current.error(error)));
      },
      complete() {
        notifyListeners(finish().map((current) => () => current.complete()));
      },
    });
    shared = entry;
  } else shared.sinks.add(consumer);

  const entry = shared;
  return () => {
    if (!entry.sinks.delete(consumer) || entry.sinks.size > 0) return;
    if (sharedSubscriptions.get(key) === entry) sharedSubscriptions.delete(key);
    entry.dispose();
  };
}

export function controlPlaneSubscriptions(): Pick<Client, "subscribe"> {
  subscriptionFacade ??= { subscribe: sharedSubscribe };
  return subscriptionFacade;
}
