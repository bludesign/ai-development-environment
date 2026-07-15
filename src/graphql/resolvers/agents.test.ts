import { describe, expect, test, vi } from "vitest";

import type { AgentControlService } from "@/services/agent-control";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createAgentResolvers } from "./agents";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

describe("agent read ownership", () => {
  test("rejects another agent's inventory and job list", async () => {
    const service = {
      getAgent: vi.fn(),
      listJobs: vi.fn(),
    } as unknown as AgentControlService;
    const query = createAgentResolvers(service).Query;

    expect(() =>
      query.agent({}, { id: "agent-2" }, context("agent-1")),
    ).toThrow("only read its own resources");
    expect(() =>
      query.agentJobs({}, { agentId: "agent-2" }, context("agent-1")),
    ).toThrow("only read its own resources");
  });

  test("rejects another agent's job payload and logs", async () => {
    const service = {
      getJob: vi.fn().mockResolvedValue({ id: "job-2", agentId: "agent-2" }),
      listLogs: vi.fn(),
    } as unknown as AgentControlService;
    const query = createAgentResolvers(service).Query;

    await expect(
      query.agentJob({}, { id: "job-2" }, context("agent-1")),
    ).rejects.toThrow("only read its own resources");
    await expect(
      query.agentJobLogs({}, { jobId: "job-2" }, context("agent-1")),
    ).rejects.toThrow("only read its own resources");
    expect(service.listLogs).not.toHaveBeenCalled();
  });
});
