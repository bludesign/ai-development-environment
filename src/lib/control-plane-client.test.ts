import { afterEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  resolveControlPlaneWebSocketUrl,
} from "./control-plane-client";

function graphQLResponse(data: Record<string, unknown>): Response {
  return Response.json({ data });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
