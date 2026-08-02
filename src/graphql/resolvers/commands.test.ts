import { afterEach, describe, expect, test } from "vitest";

import {
  COMMAND_RUNS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";

import { createCommandResolvers } from "./commands";

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
