import { afterEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  resolveControlPlaneWebSocketUrl,
} from "./control-plane-client";

function graphQLResponse(data: Record<string, unknown>): Response {
  return Response.json({ data });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pendingFetches() {
  const pending: Array<{
    signal: AbortSignal;
    resolve: (response: Response) => void;
  }> = [];
  const fetch = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init.signal as AbortSignal;
        pending.push({ signal, resolve });
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, pending };
}

describe("control-plane HTTP requests", () => {
  test("deduplicates identical queries while they are in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const first = controlPlaneRequest<{ viewer: string }>(
      "query Viewer { viewer }",
    );
    const second = controlPlaneRequest<{ viewer: string }>(
      "query Viewer { viewer }",
    );

    expect(fetch).toHaveBeenCalledOnce();
    resolveFetch(graphQLResponse({ viewer: "chandler" }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { viewer: "chandler" },
      { viewer: "chandler" },
    ]);
  });

  test("does not deduplicate mutations", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(graphQLResponse({ updateThing: true })),
    );
    vi.stubGlobal("fetch", fetch);
    const mutation = `# This operation must run for every invocation.
      mutation Update { updateThing }`;

    await Promise.all([
      controlPlaneRequest(mutation),
      controlPlaneRequest(mutation),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("limits the number of simultaneous GraphQL requests", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const requests = Array.from({ length: 7 }, (_, index) =>
      controlPlaneRequest(`query Item${index} { item }`),
    );
    expect(fetch).toHaveBeenCalledTimes(6);

    resolvers[0]!(graphQLResponse({ item: 0 }));
    await requests[0];
    expect(fetch).toHaveBeenCalledTimes(7);

    for (const [index, resolve] of resolvers.slice(1).entries()) {
      resolve(graphQLResponse({ item: index + 1 }));
    }
    await Promise.all(requests);
  });

  test("a canceled shared consumer cannot abort another consumer's read", async () => {
    const { fetch, pending } = pendingFetches();
    const controller = new AbortController();
    const first = controlPlaneRequest(
      "query Shared { item }",
      { filter: { a: 1, b: 2 } },
      { signal: controller.signal },
    );
    const second = controlPlaneRequest("query Shared { item }", {
      filter: { b: 2, a: 1 },
    });
    const canceled = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await canceled;
    expect(fetch).toHaveBeenCalledOnce();
    expect(pending[0]!.signal.aborted).toBe(false);
    pending[0]!.resolve(graphQLResponse({ item: "kept" }));
    await expect(second).resolves.toEqual({ item: "kept" });
  });

  test("removes a canceled query from the six-slot queue before dispatch", async () => {
    const { fetch, pending } = pendingFetches();
    const occupying = Array.from({ length: 6 }, (_, index) =>
      controlPlaneRequest(`query Busy${index} { item }`),
    );
    const controller = new AbortController();
    const obsolete = controlPlaneRequest("query Obsolete { item }", undefined, {
      signal: controller.signal,
    });
    const canceled = expect(obsolete).rejects.toMatchObject({
      name: "AbortError",
    });
    const wanted = controlPlaneRequest("query Wanted { item }");
    controller.abort();
    await canceled;
    pending[0]!.resolve(graphQLResponse({ item: 0 }));
    await occupying[0];
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(JSON.parse(fetch.mock.calls[6]![1].body as string).query).toContain(
      "Wanted",
    );
    for (const request of pending.slice(1))
      request.resolve(graphQLResponse({ item: 1 }));
    await Promise.all([...occupying, wanted]);
  });

  test("keeps a queued shared request until its final consumer cancels", async () => {
    const { fetch, pending } = pendingFetches();
    const occupying = Array.from({ length: 6 }, (_, index) =>
      controlPlaneRequest(`query Blocking${index} { item }`),
    );
    const controller = new AbortController();
    const first = controlPlaneRequest(
      "query QueuedShared { item }",
      undefined,
      { signal: controller.signal },
    );
    const second = controlPlaneRequest("query QueuedShared { item }");
    const canceled = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await canceled;
    pending[0]!.resolve(graphQLResponse({ item: 0 }));
    await occupying[0];
    expect(fetch).toHaveBeenCalledTimes(7);
    for (const request of pending.slice(1))
      request.resolve(graphQLResponse({ item: 1 }));
    await Promise.all([...occupying, second]);
  });

  test("aborts an active request only after all consumers cancel and permits a fresh identical read", async () => {
    const { fetch, pending } = pendingFetches();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const query = "query Abandoned { item }";
    const first = controlPlaneRequest(query, undefined, {
      signal: firstController.signal,
    });
    const second = controlPlaneRequest(query, undefined, {
      signal: secondController.signal,
    });
    const firstCanceled = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    const secondCanceled = expect(second).rejects.toMatchObject({
      name: "AbortError",
    });
    firstController.abort();
    expect(pending[0]!.signal.aborted).toBe(false);
    secondController.abort();
    expect(pending[0]!.signal.aborted).toBe(true);
    const replacement = controlPlaneRequest(query);
    await Promise.all([firstCanceled, secondCanceled]);
    const anotherConsumer = controlPlaneRequest(query);
    expect(fetch).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(graphQLResponse({ item: "fresh" }));
    await expect(Promise.all([replacement, anotherConsumer])).resolves.toEqual([
      { item: "fresh" },
      { item: "fresh" },
    ]);
  });

  test("does not dispatch an already canceled query", async () => {
    const { fetch } = pendingFetches();
    const controller = new AbortController();
    controller.abort();
    await expect(
      controlPlaneRequest("query Never { item }", undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("preserves queued and active mutations even when their caller aborts", async () => {
    const { fetch, pending } = pendingFetches();
    const occupying = Array.from({ length: 6 }, (_, index) =>
      controlPlaneRequest(`query MutationBlocker${index} { item }`),
    );
    const controller = new AbortController();
    const mutation = controlPlaneRequest(
      "mutation KeepWrite { updateThing }",
      undefined,
      { signal: controller.signal },
    );
    controller.abort();
    pending[0]!.resolve(graphQLResponse({ item: 0 }));
    await occupying[0];
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(pending[6]!.signal.aborted).toBe(false);
    for (const request of pending.slice(1))
      request.resolve(graphQLResponse({ updateThing: true }));
    await Promise.all([...occupying, mutation]);
  });

  test("disposable mutations cancel only before dispatch", async () => {
    const { fetch, pending } = pendingFetches();
    const occupying = Array.from({ length: 6 }, (_, index) =>
      controlPlaneRequest(`query InspectBlock${index} { item }`),
    );
    const queuedController = new AbortController();
    const queued = controlPlaneRequest(
      "mutation ObsoleteInspection { inspect }",
      undefined,
      { signal: queuedController.signal, cancelBeforeDispatch: true },
    );
    const cancelled = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    queuedController.abort();
    await cancelled;
    pending[0]!.resolve(graphQLResponse({ item: 0 }));
    await occupying[0];
    expect(fetch).toHaveBeenCalledTimes(6);
    const activeController = new AbortController();
    const active = controlPlaneRequest(
      "mutation AcceptedInspection { inspect }",
      undefined,
      { signal: activeController.signal, cancelBeforeDispatch: true },
    );
    activeController.abort();
    expect(pending[6]!.signal.aborted).toBe(false);
    for (const request of pending.slice(1))
      request.resolve(graphQLResponse({ inspect: true }));
    await Promise.all([...occupying, active]);
  });

  test("reports an actual timeout distinctly from consumer cancellation", async () => {
    vi.useFakeTimers();
    const { pending } = pendingFetches();
    const request = controlPlaneRequest("query Timeout { item }");
    const failure = expect(request).rejects.toThrow(
      "The GraphQL request timed out.",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(pending[0]!.signal.aborted).toBe(true);
  });
});

describe("resolveControlPlaneWebSocketUrl", () => {
  test("uses the same-origin secure proxy on HTTPS pages", () => {
    expect(
      resolveControlPlaneWebSocketUrl(
        "ws://127.0.0.1:3091/graphql",
        "https:",
        "weblocalair.fwd10.com",
      ),
    ).toBe("wss://weblocalair.fwd10.com/graphql");
  });

  test("keeps an explicitly configured secure URL", () => {
    expect(
      resolveControlPlaneWebSocketUrl(
        "wss://events.example.com/graphql",
        "https:",
        "app.example.com",
      ),
    ).toBe("wss://events.example.com/graphql");
  });

  test("uses a configured local URL on HTTP pages", () => {
    expect(
      resolveControlPlaneWebSocketUrl(
        "ws://127.0.0.1:3091/graphql",
        "http:",
        "127.0.0.1:3000",
      ),
    ).toBe("ws://127.0.0.1:3091/graphql");
  });
});
