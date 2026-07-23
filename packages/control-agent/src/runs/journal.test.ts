import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentGraphQLClient } from "../graphql-client.js";
import { RunJournal } from "./journal.js";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.CONTROL_AGENT_CONFIG;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RunJournal", () => {
  test("persists concurrent events without colliding temporary files", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "aide-run-journal-concurrency-test-"),
    );
    directories.push(directory);
    process.env.CONTROL_AGENT_CONFIG = join(directory, "config.json");
    const journal = new RunJournal("run-concurrent", "attempt-1");

    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        journal.append({ type: "SYSTEM", summary: `event-${index}` }),
      ),
    );

    expect(events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );

    const appendRunEvents = vi.fn().mockResolvedValue({ appendRunEvents: [] });
    const replay = new RunJournal("run-concurrent", "attempt-1");
    await replay.flush({ appendRunEvents } as unknown as AgentGraphQLClient);

    expect(appendRunEvents).toHaveBeenCalledOnce();
    expect(appendRunEvents.mock.calls[0]![2]).toHaveLength(20);
  });

  test("preserves monotonic ordering and replays unacknowledged events after reconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aide-run-journal-test-"));
    directories.push(directory);
    process.env.CONTROL_AGENT_CONFIG = join(directory, "config.json");
    const disconnected = {
      appendRunEvents: vi.fn().mockRejectedValue(new Error("offline")),
    } as unknown as AgentGraphQLClient;
    const first = new RunJournal("run-1", "attempt-1");
    await first.append({ type: "SYSTEM", summary: "first" });
    await first.append({ type: "TOOL", summary: "second" });
    await expect(first.flush(disconnected)).rejects.toThrow("offline");

    const appendRunEvents = vi.fn().mockResolvedValue({ appendRunEvents: [] });
    const reconnected = { appendRunEvents } as unknown as AgentGraphQLClient;
    const replay = new RunJournal("run-1", "attempt-1");
    await replay.flush(reconnected);

    expect(appendRunEvents).toHaveBeenCalledOnce();
    expect(appendRunEvents.mock.calls[0]![2]).toEqual([
      expect.objectContaining({ sequence: 0, summary: "first" }),
      expect.objectContaining({ sequence: 1, summary: "second" }),
    ]);
    await replay.flush(reconnected);
    expect(appendRunEvents).toHaveBeenCalledOnce();
  });

  test("keeps the original attempt when a later attempt replays the journal", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "aide-run-journal-attempt-test-"),
    );
    directories.push(directory);
    process.env.CONTROL_AGENT_CONFIG = join(directory, "config.json");
    const first = new RunJournal("run-2", "attempt-1");
    await first.append({ type: "SYSTEM", summary: "old attempt" });
    const second = new RunJournal("run-2", "attempt-2");
    await second.append({ type: "SYSTEM", summary: "new attempt" });
    const appendRunEvents = vi.fn().mockResolvedValue({ appendRunEvents: [] });

    await second.flush({ appendRunEvents } as unknown as AgentGraphQLClient);

    expect(appendRunEvents).toHaveBeenNthCalledWith(1, "run-2", "attempt-1", [
      expect.objectContaining({ summary: "old attempt" }),
    ]);
    expect(appendRunEvents).toHaveBeenNthCalledWith(2, "run-2", "attempt-2", [
      expect.objectContaining({ summary: "new attempt" }),
    ]);
  });
});
