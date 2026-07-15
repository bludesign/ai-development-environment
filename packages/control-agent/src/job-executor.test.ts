import { describe, expect, test, vi } from "vitest";

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
  test("does not fail a job when claiming it has a transient error", async () => {
    const client = {
      claimJob: vi.fn().mockRejectedValue(new Error("temporary HTTP failure")),
      completeJob: vi.fn(),
    } as unknown as AgentGraphQLClient;
    const executor = new JobExecutor(client);

    executor.execute(job);
    await executor.cancelAll();

    expect(client.claimJob).toHaveBeenCalledWith(job.id);
    expect(client.completeJob).not.toHaveBeenCalled();
  });
});
