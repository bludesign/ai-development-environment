import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createLiveRefresh,
  onPageVisible,
  type PageVisibility,
} from "./live-refresh";

function fakeVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const visibility: PageVisibility = {
    isHidden: () => hidden,
    onVisible(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    visibility,
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

describe("createLiveRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  test("refreshes at once, then spends one trailing refresh on a burst", () => {
    const refresh = vi.fn();
    const { visibility } = fakeVisibility();
    const live = createLiveRefresh(refresh, {
      minIntervalMs: 5_000,
      visibility,
    });

    live.invalidate();
    expect(refresh).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 20; index++) {
      vi.advanceTimersByTime(200);
      live.invalidate();
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    live.invalidate();
    expect(refresh).toHaveBeenCalledTimes(3);
    live.dispose();
  });

  test("reads nothing while hidden and catches up once on return", () => {
    const refresh = vi.fn();
    const page = fakeVisibility();
    const live = createLiveRefresh(refresh, {
      minIntervalMs: 5_000,
      pollMs: 30_000,
      visibility: page.visibility,
    });

    page.hide();
    for (let index = 0; index < 10; index++) live.invalidate();
    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();

    page.show();
    expect(refresh).toHaveBeenCalledTimes(1);
    page.show();
    expect(refresh).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  test("a skipped poll alone is enough to refresh on return", () => {
    const refresh = vi.fn();
    const page = fakeVisibility();
    const live = createLiveRefresh(refresh, {
      pollMs: 30_000,
      visibility: page.visibility,
    });

    page.hide();
    vi.advanceTimersByTime(29_000);
    page.show();
    expect(refresh).not.toHaveBeenCalled();

    page.hide();
    vi.advanceTimersByTime(2_000);
    page.show();
    expect(refresh).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  test("polls only when no refresh ran within the poll interval", () => {
    const refresh = vi.fn();
    const { visibility } = fakeVisibility();
    const live = createLiveRefresh(refresh, {
      minIntervalMs: 1_000,
      pollMs: 30_000,
      visibility,
    });

    vi.advanceTimersByTime(20_000);
    live.invalidate();
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    live.dispose();
  });

  test("defers a trailing refresh that comes due while hidden", () => {
    const refresh = vi.fn();
    const page = fakeVisibility();
    const live = createLiveRefresh(refresh, {
      minIntervalMs: 5_000,
      visibility: page.visibility,
    });

    live.invalidate();
    live.invalidate();
    page.hide();
    vi.advanceTimersByTime(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    page.show();
    expect(refresh).toHaveBeenCalledTimes(2);
    live.dispose();
  });

  test("survives a failing refresh and stops after disposal", async () => {
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("synchronous");
      })
      .mockImplementationOnce(() => Promise.reject(new Error("asynchronous")))
      .mockReturnValue(undefined);
    const page = fakeVisibility();
    const live = createLiveRefresh(refresh, {
      minIntervalMs: 1_000,
      pollMs: 10_000,
      visibility: page.visibility,
    });

    live.invalidate();
    vi.advanceTimersByTime(1_000);
    live.invalidate();
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    live.invalidate();
    expect(refresh).toHaveBeenCalledTimes(3);

    live.invalidate();
    live.dispose();
    expect(page.listeners.size).toBe(0);
    vi.advanceTimersByTime(60_000);
    live.invalidate();
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

describe("onPageVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubGlobal(
      "document",
      Object.assign(new EventTarget(), { visibilityState: "visible" }),
    );
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("reports one return when focus and visibility change together", () => {
    const listener = vi.fn();
    const off = onPageVisible(listener);
    const page = document as unknown as { visibilityState: string };

    page.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();

    page.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
