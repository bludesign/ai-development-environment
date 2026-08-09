import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { CliHealthService } from "@/services/cli-health";
import { createCliHealthResolvers } from "./cli-health";

const control = { agentId: null } as GraphQLContext;
const agent = { agentId: "agent-1" } as GraphQLContext;

describe("CLI health resolvers", () => {
  test("allows control-plane reads and mutations", async () => {
    const service = {
      installationStatus: vi.fn().mockResolvedValue({ version: "1.2.3" }),
      statusForAgent: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      run: vi.fn().mockResolvedValue({ version: "1.2.3" }),
      saveSettings: vi.fn().mockResolvedValue({ version: "1.2.3" }),
    } as unknown as CliHealthService;
    const resolvers = createCliHealthResolvers(service);
    await expect(
      resolvers.Query.installationStatus({}, {}, control),
    ).resolves.toMatchObject({ version: "1.2.3" });
    await resolvers.Mutation.runCliHealthChecks(
      {},
      { agentId: "agent-1" },
      control,
    );
    expect(service.run).toHaveBeenCalledWith("agent-1");
  });

  test("rejects agent credentials", () => {
    const resolvers = createCliHealthResolvers({} as CliHealthService);
    expect(() => resolvers.Query.installationStatus({}, {}, agent)).toThrow(
      "Agent credentials cannot perform control-plane operations",
    );
    expect(() =>
      resolvers.Mutation.saveCliHealthSettings({}, { checks: [] }, agent),
    ).toThrow("Agent credentials cannot perform control-plane operations");
  });
});
