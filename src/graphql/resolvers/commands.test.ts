import { afterEach, describe, expect, test, vi } from "vitest";

import {
  COMMAND_RUNS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import { CommandPortConflictError } from "@/services/commands";

import { createCommandResolvers } from "./commands";

test("returns structured port conflict details to command clients", async () => {
  const conflict = {
    agentId: "agent-1",
    agentName: "Builder",
    port: 3000,
    runs: [
      { id: "run-1", displayNumber: 1, name: "Preview", status: "RUNNING" },
    ],
  };
  const startRun = vi
    .fn()
    .mockRejectedValue(new CommandPortConflictError(conflict));
  const resolvers = createCommandResolvers({ startRun } as never);
  await expect(
    resolvers.Mutation.startCommandRun(
      null,
      { input: { commandId: "command-1", agentId: "agent-1" } },
      {} as never,
    ),
  ).rejects.toMatchObject({
    extensions: { code: "COMMAND_PORT_CONFLICT", portConflict: conflict },
  });
});

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
