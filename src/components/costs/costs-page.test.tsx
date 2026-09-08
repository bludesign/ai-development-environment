import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { CostsPage } from "./costs-page";

const state = vi.hoisted(() => ({
  notify: undefined as undefined | (() => void),
}));
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: () => () => undefined,
  controlPlaneSubscriptions: () => ({
    subscribe: (_input: unknown, sink: { next: (value: unknown) => void }) => {
      state.notify = () =>
        sink.next({
          data: {
            modelCostCatalogChanged: {
              url: "https://example.com/costs",
              defaultUrl: "https://example.com/costs",
              customUrl: null,
              fetchedAt: null,
              entryCount: 300,
              error: null,
              stale: false,
            },
          },
        });
      return () => undefined;
    },
  }),
}));
const request = vi.mocked(controlPlaneRequest);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
test("reconciles all loaded prices in one bounded read without repeating catalog discovery", async () => {
  let more!: IntersectionObserverCallback;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        more = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const entries = Array.from({ length: 300 }, (_, i) => ({
    model: `model-${String(i).padStart(3, "0")}`,
    provider: null,
    mode: null,
    inputCostPerToken: null,
    outputCostPerToken: null,
    cacheReadCostPerToken: null,
    cacheWriteCostPerToken: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    updatedAt: "2026-09-08T00:00:00Z",
  }));
  request.mockImplementation(async (query, input) => {
    if (query.includes("query ModelCostConfiguration"))
      return {
        modelCostCatalog: {
          url: "https://example.com/costs",
          defaultUrl: "https://example.com/costs",
          customUrl: null,
          fetchedAt: null,
          entryCount: 300,
          error: null,
          stale: false,
        },
      } as never;
    const { first, offset = 0 } = input as { first: number; offset?: number };
    return {
      modelCostEntries: {
        items: entries.slice(offset, offset + first),
        totalCount: entries.length,
      },
    } as never;
  });
  render(<CostsPage />);
  await screen.findByText("model-099");
  act(() =>
    more(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  await screen.findByText("model-199");
  const count = request.mock.calls.length;
  act(() => state.notify?.());
  await waitFor(() => expect(request.mock.calls.length).toBe(count + 1));
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
    first: 200,
    offset: 0,
  });
  expect(screen.getByText("model-199")).toBeTruthy();
  expect(
    request.mock.calls.filter(([query]) =>
      query.includes("query ModelCostConfiguration"),
    ),
  ).toHaveLength(1);
});
