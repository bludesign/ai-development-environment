import { afterEach, describe, expect, test, vi } from "vitest";

import {
  COMMAND_RUNS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";

import { createCommandResolvers } from "./commands";

test("batched command summaries require control-plane credentials and preserve input", async () => {
  const targetSummaries = vi.fn().mockResolvedValue([]);
  const resolvers = createCommandResolvers({ targetSummaries } as never);
  const targets = [
    {
      resourceKind: "AGENT" as const,
      resourceId: "agent",
      includeRecentRuns: true,
    },
  ];
  expect(() =>
    resolvers.Query.commandTargetSummaries(null, { targets }, {
      agentId: "agent",
    } as never),
  ).toThrow("Agent credentials");
  expect(targetSummaries).not.toHaveBeenCalled();
  await expect(
    resolvers.Query.commandTargetSummaries(null, { targets }, {} as never),
  ).resolves.toEqual([]);
  expect(targetSummaries).toHaveBeenCalledWith(targets);
});

describe("command run subscriptions", () => {
  const iterators: AsyncIterableIterator<unknown>[] = [];

  afterEach(async () => {
    await Promise.all(
      iterators.splice(0).map((iterator) => iterator.return?.()),
    );
  });

  test("delivers only events for the requested target", async () => {
    const resolvers = createCommandResolvers({} as never);
    const iterator = resolvers.Subscription.commandRunsChanged.subscribe(
      null,
      { worktreeId: "worktree-1" },
      {} as never,
    );
    iterators.push(iterator);

    agentEventBus.publish(COMMAND_RUNS_CHANGED_TOPIC, {
      commandRunsChanged: {
        id: "other-run",
        agentId: "agent-1",
        worktreeId: "worktree-2",
      },
    });
    agentEventBus.publish(COMMAND_RUNS_CHANGED_TOPIC, {
      commandRunsChanged: {
        id: "matching-run",
        agentId: "agent-1",
        worktreeId: "worktree-1",
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { commandRunsChanged: { id: "matching-run" } },
    });
  });
});
