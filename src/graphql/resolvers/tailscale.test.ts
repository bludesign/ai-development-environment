import { describe, expect, test, vi } from "vitest";

import { createTailscaleResolvers } from "./tailscale";

describe("Tailscale resolvers", () => {
  test("maps typed mutations and operation subscriptions to the service", async () => {
    const setAgentEnabled = vi.fn().mockResolvedValue({ id: "operation-1" });
    const subscribeOperation = vi.fn().mockReturnValue("operation-stream");
    const operation = vi.fn().mockResolvedValue({ id: "operation-1" });
    const resolvers = createTailscaleResolvers({
      setAgentEnabled,
      subscribeOperation,
      operation,
    } as never);
    const context = { agentId: null } as never;

    await resolvers.Mutation.setTailscaleServeAgentEnabled(
      null,
      {
        templateId: "template-1",
        agentId: "agent-1",
        enabled: false,
        expectedRevision: 3,
        requestId: "request-1",
      },
      context,
    );
    expect(setAgentEnabled).toHaveBeenCalledWith(
      "template-1",
      "agent-1",
      false,
      3,
      "request-1",
    );
    expect(
      resolvers.Subscription.tailscaleServeOperationChanged.subscribe(
        null,
        { id: "operation-1" },
        context,
      ),
    ).toBe("operation-stream");
    await resolvers.Subscription.tailscaleServeOperationChanged.resolve(null, {
      id: "operation-1",
    });
    expect(operation).toHaveBeenCalledWith("operation-1");
  });

  test("rejects agent credentials for control-plane operations", async () => {
    const overview = vi.fn();
    const resolvers = createTailscaleResolvers({ overview } as never);
    expect(() =>
      resolvers.Query.tailscaleServeOverview(null, null, {
        agentId: "agent-1",
      } as never),
    ).toThrow(/Agent credentials/);
    expect(overview).not.toHaveBeenCalled();
  });
});
