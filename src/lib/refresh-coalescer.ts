export type RefreshCoalescer = {
  refresh(): Promise<void>;
  /** Reuse an in-flight read when the caller has no newer data invalidation. */
  refreshIfIdle(): Promise<void>;
  dispose(): void;
};

/**
 * Starts immediately and retains one trailing refresh for invalidations received
 * while a refresh is running. Invalidations during that trailing refresh are
 * retained too, so an event arriving after its read cannot be lost.
 *
 * Callers share the promise for the whole drain. Its result reflects the last
 * refresh; a failed read does not discard an already requested trailing read.
 * Dispose aborts the current read and drops subsequent work. The callback must
 * forward the signal to its requests and check it before committing view state.
 */
export function createRefreshCoalescer(
  callback: (signal: AbortSignal) => Promise<unknown> | unknown,
): RefreshCoalescer {
  let disposed = false;
  let dirty = false;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;

  const drain = async () => {
    let failed = false;
    let failure: unknown;
    do {
      dirty = false;
      controller = new AbortController();
      try {
        await callback(controller.signal);
        failed = false;
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        controller = null;
      }
    } while (dirty && !disposed);
    // Clear synchronously with the final read. A caller scheduled between this
    // async function settling and its promise handlers must start fresh work,
    // rather than mark an already finished drain dirty.
    running = null;
    if (failed && !disposed) throw failure;
  };

  const refresh = (invalidate = true) => {
    if (disposed) return Promise.resolve();
    if (running) {
      if (invalidate) dirty = true;
      return running;
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    running = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const result = running;
    // Install `running` before invoking the callback, including when it causes
    // another synchronous invalidation.
    void drain().then(
      () => {
        resolve();
      },
      (error: unknown) => {
        reject(error);
      },
    );
    return result;
  };
  return {
    refresh: () => refresh(),
    refreshIfIdle: () => refresh(false),
    dispose() {
      disposed = true;
      dirty = false;
      controller?.abort();
    },
  };
}
