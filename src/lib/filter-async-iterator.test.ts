import { expect, test, vi } from "vitest";
import { filterAsyncIterator } from "./filter-async-iterator";

test("skips unrelated events and preserves order", async () => {
  async function* values() {
    yield 1;
    yield 2;
    yield 3;
    yield 4;
  }
  const filtered = filterAsyncIterator(
    values(),
    async (value) => value % 2 === 0,
  );
  expect(await filtered.next()).toEqual({ value: 2, done: false });
  expect(await filtered.next()).toEqual({ value: 4, done: false });
  expect((await filtered.next()).done).toBe(true);
});

test("closes its source immediately while an asynchronous predicate is pending", async () => {
  let accept!: (value: boolean) => void;
  const source: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: vi.fn(async () => ({ done: false as const, value: 1 })),
    return: vi.fn(async () => ({ done: true as const, value: undefined })),
  };
  const filtered = filterAsyncIterator(
    source,
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const pending = filtered.next();
  await Promise.resolve();
  await filtered.return!();
  expect(source.return).toHaveBeenCalledTimes(1);
  accept(true);
  expect((await pending).done).toBe(true);
  expect((await filtered.next()).done).toBe(true);
  expect(source.next).toHaveBeenCalledTimes(1);
});
