import { describe, expect, test, vi } from "vitest";

import { createRefreshCoalescer } from "./refresh-coalescer";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("createRefreshCoalescer", () => {
  test("starts immediately and combines an in-flight event burst into one trailing read", async () => {
    const first = deferred();
    const second = deferred();
    const callback = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const coalescer = createRefreshCoalescer(callback);
    const done = coalescer.refresh();
    expect(callback).toHaveBeenCalledOnce();
    for (let index = 0; index < 20; index++)
      expect(coalescer.refresh()).toBe(done);
    first.resolve();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(2);
    second.resolve();
    await done;
    expect(callback).toHaveBeenCalledTimes(2);
  });

  test("connection setup reuses an initial read without losing subsequent invalidations", async () => {
    const first = deferred();
    const callback = vi.fn().mockReturnValueOnce(first.promise);
    const coalescer = createRefreshCoalescer(callback);
    const read = coalescer.refresh();
    expect(coalescer.refreshIfIdle()).toBe(read);
    first.resolve();
    await read;
    expect(callback).toHaveBeenCalledTimes(1);
    const next = coalescer.refreshIfIdle();
    coalescer.refresh();
    await next;
    expect(callback).toHaveBeenCalledTimes(3);
  });

  test("retains invalidations received during the trailing read", async () => {
    const first = deferred();
    const second = deferred();
    const callback = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const coalescer = createRefreshCoalescer(callback);
    const done = coalescer.refresh();
    coalescer.refresh();
    first.resolve();
    await Promise.resolve();
    coalescer.refresh();
    second.resolve();
    await done;
    expect(callback).toHaveBeenCalledTimes(3);
  });

  test("disposal aborts the current read and discards the trailing read", async () => {
    let observedSignal!: AbortSignal;
    const callback = vi.fn((signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    });
    const coalescer = createRefreshCoalescer(callback);
    const done = coalescer.refresh();
    coalescer.refresh();
    coalescer.dispose();
    await expect(done).resolves.toBeUndefined();
    await coalescer.refresh();
    expect(observedSignal.aborted).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
  });

  test("a failed read retains pending work and a failure does not poison later refreshes", async () => {
    const first = deferred();
    const callback = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const coalescer = createRefreshCoalescer(callback);
    const done = coalescer.refresh();
    coalescer.refresh();
    first.reject(new Error("stale connection"));
    await expect(done).resolves.toBeUndefined();
    await expect(coalescer.refresh()).rejects.toThrow("offline");
    await expect(coalescer.refresh()).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(4);
  });

  test("a synchronous callback invalidation schedules only a trailing read", async () => {
    const callback = vi.fn(() => {
      if (callback.mock.calls.length === 1) coalescer.refresh();
    });
    const coalescer = createRefreshCoalescer(callback);
    await coalescer.refresh();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  test("does not lose a refresh between the final read settling and drain resolution", async () => {
    const first = deferred();
    const callback = vi.fn().mockReturnValueOnce(first.promise);
    const coalescer = createRefreshCoalescer(callback);
    const done = coalescer.refresh();
    first.resolve();
    const followup = Promise.resolve().then(() => coalescer.refresh());
    await Promise.all([done, followup]);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
