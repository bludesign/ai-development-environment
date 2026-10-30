import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  async function setup(runId: string) {
    const directory = await mkdtemp(join(tmpdir(), "aide-run-journal-test-"));
    directories.push(directory);
    process.env.CONTROL_AGENT_CONFIG = join(directory, "config.json");
    const runDirectory = join(directory, "runs", runId);
    return {
      journal: new RunJournal(runId, "attempt-1"),
      eventsPath: join(runDirectory, "events.jsonl"),
      statePath: join(runDirectory, "state.json"),
    };
  }

  test("reads only unacknowledged bytes, including after a restart and with Unicode", async () => {
    const { journal, eventsPath } = await setup("incremental");
    const appendRunEvents = vi.fn().mockResolvedValue({});
    const client = { appendRunEvents } as unknown as AgentGraphQLClient;
    await journal.append({ type: "SYSTEM", summary: "日本語 🎉" });
    await journal.flush(client);
    // An acknowledged prefix is no longer needed to parse new output. Making
    // it invalid JSON catches a regression to reading the complete journal.
    const file = await open(eventsPath, "r+");
    await file.write(Buffer.from("!"), 0, 1, 0);
    await file.close();
    await journal.append({ type: "SYSTEM", summary: "second" });
    await journal.flush(client);
    const replay = new RunJournal("incremental", "attempt-2");
    await replay.append({ type: "SYSTEM", summary: "third" });
    await replay.flush(client);
    expect(
      appendRunEvents.mock.calls.map(([, , events]) =>
        events.map((event: { summary: string }) => event.summary),
      ),
    ).toEqual([["日本語 🎉"], ["second"], ["third"]]);
  });

  test("migrates legacy state and recovers appends not recorded in state.json", async () => {
    const { journal, statePath } = await setup("legacy");
    await journal.append({ type: "SYSTEM", summary: "acknowledged" });
    await journal.append({ type: "SYSTEM", summary: "not acknowledged" });
    await writeFile(
      statePath,
      JSON.stringify({ acknowledged: 0, nextSequence: 1 }),
    );
    const replay = new RunJournal("legacy", "attempt-2");
    const event = await replay.append({ type: "SYSTEM", summary: "new" });
    expect(event.sequence).toBe(2);
    const appendRunEvents = vi.fn().mockResolvedValue({});
    await replay.flush({ appendRunEvents } as unknown as AgentGraphQLClient);
    expect(
      appendRunEvents.mock.calls.flatMap(([, , events]) =>
        events.map((event: { sequence: number }) => event.sequence),
      ),
    ).toEqual([1, 2]);
    expect(
      JSON.parse(await readFile(statePath, "utf8")).acknowledgedOffset,
    ).toBeGreaterThan(0);
  });

  test("replays only failed batches after restarting", async () => {
    const { journal } = await setup("batches");
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        journal.append({ type: "SYSTEM", summary: String(index) }),
      ),
    );
    const upload = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      journal.flush({
        appendRunEvents: upload,
      } as unknown as AgentGraphQLClient),
    ).rejects.toThrow("offline");
    const appendRunEvents = vi.fn().mockResolvedValue({});
    await new RunJournal("batches", "attempt-2").flush({
      appendRunEvents,
    } as unknown as AgentGraphQLClient);
    expect(
      appendRunEvents.mock.calls.map(([, , events]) => events.length),
    ).toEqual([100, 5]);
    expect(appendRunEvents.mock.calls[0]![2][0].sequence).toBe(100);
  });

  test("drains output appended while an upload is in flight", async () => {
    const { journal } = await setup("in-flight");
    await journal.append({ type: "SYSTEM", summary: "first" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const appendRunEvents = vi
      .fn()
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      })
      .mockResolvedValue({});
    const client = { appendRunEvents } as unknown as AgentGraphQLClient;
    const first = journal.flush(client);
    await started.promise;
    await journal.append({ type: "SYSTEM", summary: "second" });
    const second = journal.flush(client);
    release.resolve();
    await Promise.all([first, second]);
    expect(
      appendRunEvents.mock.calls.flatMap(([, , events]) =>
        events.map((event: { summary: string }) => event.summary),
      ),
    ).toEqual(["first", "second"]);
  });

  test("removes a partial final write before appending new events", async () => {
    const { journal, eventsPath } = await setup("partial");
    await journal.append({ type: "SYSTEM", summary: "complete" });
    await appendFile(eventsPath, '{"summary":"incomplete');
    const replay = new RunJournal("partial", "attempt-2");
    await replay.append({ type: "SYSTEM", summary: "new" });
    const appendRunEvents = vi.fn().mockResolvedValue({});
    await replay.flush({ appendRunEvents } as unknown as AgentGraphQLClient);
    expect(
      appendRunEvents.mock.calls.flatMap(([, , events]) =>
        events.map((event: { sequence: number }) => event.sequence),
      ),
    ).toEqual([0, 1]);
  });

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
