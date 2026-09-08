// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useOwnedRead } from "./use-owned-read";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("shares initial and burst reads, retaining one trailing invalidation", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const read = vi
    .fn<(signal: AbortSignal) => Promise<void>>()
    .mockReturnValueOnce(pending)
    .mockResolvedValue(undefined);
  const { result } = renderHook(() => useOwnedRead(read));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(read).toHaveBeenCalledTimes(1);
  let settled!: Promise<void>;
  act(() => {
    settled = result.current();
    for (let index = 0; index < 8; index++) void result.current();
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    await settled;
  });
  expect(read).toHaveBeenCalledTimes(2);
});

test("aborts replaced or unmounted scopes and ignores late refresh callers", async () => {
  vi.useFakeTimers();
  const first = vi.fn(
    async (_signal: AbortSignal) => new Promise<void>(() => undefined),
  );
  const second = vi.fn(async (_signal: AbortSignal) => undefined);
  const { result, rerender, unmount } = renderHook(
    ({ callback, enabled }) => useOwnedRead(callback, { enabled }),
    { initialProps: { callback: first, enabled: true } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const signal = first.mock.calls[0][0];
  const refresh = result.current;
  rerender({ callback: second, enabled: false });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    await refresh();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(second).not.toHaveBeenCalled();
  rerender({ callback: second, enabled: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(second).toHaveBeenCalledTimes(1);
  expect(result.current).toBe(refresh);
  unmount();
  await refresh();
  expect(second).toHaveBeenCalledTimes(1);
});
