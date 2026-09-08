import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useSseLiveReload } from "./use-sse-live-reload";

const { subscribe, connected } = vi.hoisted(() => ({
  subscribe: vi.fn(() => vi.fn()),
  connected: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneSubscriptions: () => ({ subscribe }),
  onControlPlaneRecovery: connected,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SSE live reload ownership", () => {
  test("parent renders retain one registration and call the latest loader", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = renderHook(
      ({ reload }) => useSseLiveReload("endpoints", reload),
      { initialProps: { reload: first } },
    );
    view.rerender({ reload: second });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const sink = (
      subscribe.mock.calls[0] as unknown as [
        unknown,
        { next(value: unknown): void },
      ]
    )[1];
    await act(async () =>
      sink.next({ data: { sseEndpointsChanged: { ids: ["endpoint"] } } }),
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("unsaved editors do not subscribe and detail pages ignore other IDs", async () => {
    const reload = vi.fn();
    const view = renderHook(
      ({ enabled }) =>
        useSseLiveReload("endpoints", reload, { enabled, id: "one" }),
      { initialProps: { enabled: false } },
    );
    expect(subscribe).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    const sink = (
      subscribe.mock.calls[0] as unknown as [
        unknown,
        { next(value: unknown): void },
      ]
    )[1];
    await act(async () =>
      sink.next({ data: { sseEndpointsChanged: { ids: ["two"] } } }),
    );
    expect(reload).not.toHaveBeenCalled();
    await act(async () =>
      sink.next({ data: { sseEndpointsChanged: { ids: [] } } }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
