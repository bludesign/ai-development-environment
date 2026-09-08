import { expect, test } from "vitest";

import { mapIntegrationRequests } from "./integration-request";

test("bounds upstream concurrency and preserves order across out-of-order completions", async () => {
  const gates = Array.from({ length: 6 }, () =>
    Promise.withResolvers<number>(),
  );
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const result = mapIntegrationRequests(
    gates,
    async (gate, index) => {
      started.push(index);
      peak = Math.max(peak, ++active);
      const value = await gate.promise;
      active -= 1;
      return value;
    },
    2,
  );
  expect(started).toEqual([0, 1]);
  gates[1].resolve(11);
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2]);
  for (const [index, gate] of gates.entries()) gate.resolve(index + 10);
  expect(await result).toEqual([10, 11, 12, 13, 14, 15]);
  expect(peak).toBe(2);
});

test("does not start queued enrichment after the caller has failed", async () => {
  const gate = Promise.withResolvers<void>();
  const started: number[] = [];
  const result = mapIntegrationRequests(
    [0, 1, 2, 3],
    async (item) => {
      started.push(item);
      if (item === 0) throw new Error("unavailable");
      await gate.promise;
      return item;
    },
    2,
  );
  await expect(result).rejects.toThrow("unavailable");
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
});
