import { describe, expect, test } from "vitest";

import { AsyncEventBus } from "./event-bus";

describe("AsyncEventBus", () => {
  test("removes an empty topic after its last iterator closes", async () => {
    const bus = new AsyncEventBus();
    const iterator = bus.iterate("job.test.changed");

    await iterator.return?.();

    const subscribers = (
      bus as unknown as { subscribers: Map<string, Set<unknown>> }
    ).subscribers;
    expect(subscribers.size).toBe(0);
  });
});
