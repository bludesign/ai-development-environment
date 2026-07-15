import { afterEach, describe, expect, test, vi } from "vitest";
import type { Client, Sink } from "graphql-ws";

import {
  AgentGraphQLClient,
  subscribeToAgentEvents,
  type AgentJob,
} from "./graphql-client.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AgentGraphQLClient", () => {
  test("aborts a hung fetch at the configured request timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }),
    );
    const client = new AgentGraphQLClient("http://control.test", null, 5);

    await expect(client.health()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  test("includes cancelled jobs so durable reconciliation can stop them", async () => {
    const client = new AgentGraphQLClient("http://control.test");
    vi.spyOn(client, "request").mockResolvedValue({
      agentJobs: [
        { id: "queued", status: "QUEUED" },
        { id: "cancelled", status: "CANCELLED" },
        { id: "done", status: "SUCCEEDED" },
      ],
    });

    await expect(client.pendingJobs("agent-1")).resolves.toEqual([
      { id: "queued", status: "QUEUED" },
      { id: "cancelled", status: "CANCELLED" },
    ]);
  });
});

describe("subscribeToAgentEvents", () => {
  test("resubscribes after an operation error", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sinks: Array<Sink<{ agentEvents: { job: AgentJob } }>> = [];
    const client = {
      subscribe: vi.fn((_request, sink) => {
        sinks.push(sink);
        return () => undefined;
      }),
    } as unknown as Client;

    const unsubscribe = subscribeToAgentEvents(
      client,
      "agent-1",
      () => undefined,
    );
    sinks[0]?.error(new Error("server operation failed"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.subscribe).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
