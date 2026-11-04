import { describe, expect, test } from "vitest";
import { acquireAgentLeadership } from "./agent-leadership.js";

describe("agent runtime leadership", () => {
  test("excludes another runtime and releases the kernel lease on shutdown", async () => {
    const first = await acquireAgentLeadership("test-agent", 0);
    try {
      await expect(
        acquireAgentLeadership("test-agent", first.port),
      ).rejects.toThrow("exclusive local runtime port");
    } finally {
      await first.release();
    }
    const next = await acquireAgentLeadership("test-agent", first.port);
    await next.release();
  });
});
