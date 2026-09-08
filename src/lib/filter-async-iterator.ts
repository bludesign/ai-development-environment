/** Filter without leaving the source subscribed when a consumer returns during a pending next(). */
export function filterAsyncIterator<T>(
  source: AsyncIterableIterator<T>,
  accept: (value: T) => boolean | Promise<boolean>,
): AsyncIterableIterator<T> {
  let closed = false;
  const done = (): IteratorResult<T> => ({ done: true, value: undefined });
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      while (!closed) {
        const result = await source.next();
        if (closed || result.done) return done();
        const accepted = await accept(result.value);
        if (closed) return done();
        if (accepted) return result;
      }
      return done();
    },
    async return() {
      closed = true;
      await source.return?.();
      return done();
    },
    async throw(error) {
      closed = true;
      await source.return?.();
      throw error;
    },
  };
}

/** Attach the source before replay, and close it immediately even during a pending next. */
export function prependAsyncIterator<T>(
  source: AsyncIterableIterator<T>,
  initial: T,
): AsyncIterableIterator<T> {
  let pending = true;
  let closed = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (closed)
        return Promise.resolve({ done: true as const, value: undefined });
      if (pending) {
        pending = false;
        return Promise.resolve({ done: false as const, value: initial });
      }
      return source.next();
    },
    async return() {
      closed = true;
      await source.return?.();
      return { done: true, value: undefined };
    },
    async throw(error) {
      closed = true;
      await source.return?.();
      throw error;
    },
  };
}
