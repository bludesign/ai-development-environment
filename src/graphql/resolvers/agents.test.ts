import { describe, expect, test, vi } from "vitest";

import type { AgentControlService } from "@/services/agent-control";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createAgentResolvers } from "./agents";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

describe("agent read ownership", () => {
  test("derives the build folder from the base repository directory", () => {
    const service = {} as AgentControlService;
    const resolver =
      createAgentResolvers(service).Agent.effectiveBuildsDirectory;

    expect(
      resolver({
        baseRepoDirectory: "/Users/test/Repositories",
        buildsDirectory: null,
      }),
    ).toBe("/Users/test/Repositories/Builds");
    expect(
      resolver({
        baseRepoDirectory: "/Users/test/Repositories",
        buildsDirectory: "/Volumes/Builds",
      }),
    ).toBe("/Volumes/Builds");
  });

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

  test("only the control plane can update the base repository directory", async () => {
    const service = {
      updateBaseRepoDirectory: vi.fn().mockResolvedValue({ id: "agent-1" }),
    } as unknown as AgentControlService;
    const mutation =
      createAgentResolvers(service).Mutation.updateAgentBaseRepoDirectory;

    expect(() =>
      mutation(
        {},
        { agentId: "agent-1", baseRepoDirectory: "/Users/test/Repositories" },
        context("agent-1"),
      ),
    ).toThrow("cannot perform control-plane operations");
    await expect(
      mutation(
        {},
        { agentId: "agent-1", baseRepoDirectory: "/Users/test/Repositories" },
        context(null),
      ),
    ).resolves.toEqual({ id: "agent-1" });
  });

  test("only the control plane can request an immediate codebase reconcile", async () => {
    const service = {
      requestCodebaseReconcile: vi.fn().mockResolvedValue(1),
    } as unknown as AgentControlService;
    const mutation =
      createAgentResolvers(service).Mutation.requestAgentCodebaseReconcile;

    await expect(
      mutation({}, { agentId: "agent-1" }, context("agent-1")),
    ).rejects.toThrow("cannot perform control-plane operations");
    await expect(
      mutation({}, { agentId: "agent-1" }, context(null)),
    ).resolves.toBe(true);
    expect(service.requestCodebaseReconcile).toHaveBeenCalledWith(["agent-1"]);
  });
});
