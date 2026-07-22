import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentGraphQLClient, AgentJob } from "./graphql-client.js";
import { JobExecutor } from "./job-executor.js";

const job: AgentJob = {
  id: "job-1",
  agentId: "agent-1",
  kind: "cloudflared.runTunnel",
  payload: { tunnelName: "example" },
  status: "QUEUED",
  timeoutSeconds: 60,
};

describe("JobExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("does not fail a job when claiming it has a transient error", async () => {
    // The transient path reports itself on stderr; capture it rather than
    // letting it interleave with the reporter output.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      claimJob: vi.fn().mockRejectedValue(new Error("temporary HTTP failure")),
      completeJob: vi.fn(),
    } as unknown as AgentGraphQLClient;
    const executor = new JobExecutor(client);

    executor.execute(job);
    await executor.cancelAll();

    expect(client.claimJob).toHaveBeenCalledWith(job.id);
    expect(client.completeJob).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      `Could not claim job ${job.id}; durable reconciliation will retry:`,
      "temporary HTTP failure",
    );
  });
});
