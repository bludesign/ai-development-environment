import { afterEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { WorkflowsService } from "./workflows.service";
import { WorkflowEventBridge } from "./workflow-event-bridge";
import {
  agentEventBus,
  BUILD_DATA_CHANGED_TOPIC,
} from "@/services/agent-control";

afterEach(() => vi.useRealTimers());

function matcher() {
  const states = new Map<string, Record<string, unknown>>();
  const stateKey = (where: {
    triggerId_subjectKey: { triggerId: string; subjectKey: string };
  }) => JSON.stringify(where.triggerId_subjectKey);
  getPrismaClient.mockResolvedValue({
    workflowTriggerState: {
      findUnique: vi.fn(
        async ({ where }) => states.get(stateKey(where)) ?? null,
      ),
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = stateKey(where);
        const value = states.has(key)
          ? { ...states.get(key), ...update }
          : create;
        states.set(key, value);
        return value;
      }),
    },
  });
  const service = new WorkflowsService({} as never) as unknown as {
    triggerMatches(
      trigger: { id: string; kind: string; configJson: string },
      subject: string,
      payload: Record<string, unknown>,
    ): Promise<boolean>;
  };
  return (
    kind: string,
    config: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) =>
    service.triggerMatches(
      { id: kind, kind, configJson: JSON.stringify(config) },
      "resource",
      payload,
    );
}

describe("timed workflow triggers", () => {
  test("dirty filters do not suppress clean resets or consume a nonmatching threshold crossing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    const matches = matcher();
    const config = {
      durationSeconds: 60,
      filters: { "worktree.dirty": true, "worktree.branch": "feature" },
    };
    const payload = (dirty: boolean, branch = "feature") => ({
      worktree: { dirty, branch },
      sessionData: { worktree: { dirty, branch } },
    });
    expect(
      await matches("WORKTREE_DIRTY_DURATION", config, payload(true)),
    ).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(
      await matches("WORKTREE_DIRTY_DURATION", config, payload(true)),
    ).toBe(true);
    expect(
      await matches("WORKTREE_DIRTY_DURATION", config, payload(false)),
    ).toBe(false);
    expect(
      await matches("WORKTREE_DIRTY_DURATION", config, payload(true, "other")),
    ).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(
      await matches("WORKTREE_DIRTY_DURATION", config, payload(true, "other")),
    ).toBe(false);
    expect(
      await matches("WORKTREE_DIRTY_DURATION", config, payload(true)),
    ).toBe(true);
    expect(
      await matches("WORKTREE_DIRTY_DURATION", config, payload(true)),
    ).toBe(false);
  });

  test("dirty duration persists across polling, fires once, and resets when clean", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    const matches = matcher();
    const payload = (dirty: boolean) => ({
      worktree: { dirty },
      sessionData: { worktree: { dirty } },
      cursorValue: new Date().toISOString(),
    });
    expect(
      await matches(
        "WORKTREE_DIRTY_DURATION",
        { durationSeconds: 60 },
        payload(false),
      ),
    ).toBe(false);
    expect(
      await matches(
        "WORKTREE_DIRTY_DURATION",
        { durationSeconds: 60 },
        payload(true),
      ),
    ).toBe(false);
    vi.advanceTimersByTime(60000);
    const eligible = payload(true);
    expect(
      await matches(
        "WORKTREE_DIRTY_DURATION",
        { durationSeconds: 60 },
        eligible,
      ),
    ).toBe(true);
    expect(eligible.worktree).toMatchObject({
      dirtySince: "2026-10-28T12:00:00.000Z",
      dirtyDurationSeconds: 60,
    });
    expect(
      await matches(
        "WORKTREE_DIRTY_DURATION",
        { durationSeconds: 60 },
        payload(true),
      ),
    ).toBe(false);
    expect(
      await matches(
        "WORKTREE_DIRTY_DURATION",
        { durationSeconds: 60 },
        payload(false),
      ),
    ).toBe(false);
    expect(
      await matches(
        "WORKTREE_DIRTY_DURATION",
        { durationSeconds: 60 },
        payload(true),
      ),
    ).toBe(false);
  });

  test("signing expiry defaults to thirty days and fires on each threshold crossing", async () => {
    const matches = matcher();
    const payload = (expiresInDays: number) => ({
      signingProfile: { id: "profile", expiresInDays },
      cursorValue: "same-expiry",
    });
    expect(await matches("SIGNING_ASSET_EXPIRING", {}, payload(31))).toBe(
      false,
    );
    expect(await matches("SIGNING_ASSET_EXPIRING", {}, payload(30))).toBe(true);
    expect(await matches("SIGNING_ASSET_EXPIRING", {}, payload(29))).toBe(
      false,
    );
    expect(await matches("SIGNING_ASSET_EXPIRING", {}, payload(90))).toBe(
      false,
    );
    expect(await matches("SIGNING_ASSET_EXPIRING", {}, payload(30))).toBe(true);
  });

  test("expiry is audited without asset mutations using a fresh observation key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    getPrismaClient.mockResolvedValue({
      workflowTrigger: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const record = vi.fn().mockResolvedValue({});
    const bridge = new WorkflowEventBridge(
      { record } as never,
      { registerCompletionObserver: vi.fn() } as never,
      undefined,
      undefined,
      {
        signingAssets: {
          profiles: vi
            .fn()
            .mockResolvedValue([
              { id: "profile", expiresAt: "2026-11-28T12:00:00.000Z" },
            ]),
          operations: vi.fn().mockResolvedValue([]),
        } as never,
      },
    );
    bridge.start();
    try {
      await vi.advanceTimersByTimeAsync(60000);
      const observations = record.mock.calls
        .map(([input]) => input)
        .filter((input) => input.kind === "SIGNING_ASSET_EXPIRING");
      expect(observations).toHaveLength(2);
      expect(observations[0].dedupeKey).not.toBe(observations[1].dedupeKey);
      expect(
        observations[0].payload.signingProfile.expiresInSeconds -
          observations[1].payload.signingProfile.expiresInSeconds,
      ).toBe(60);
    } finally {
      bridge.stop();
    }
  });

  test("build-data sizing revisions are fresh and cleanup comes only from deletion jobs", async () => {
    const record = vi.fn().mockResolvedValue({});
    const getCollection = vi.fn().mockResolvedValue({
      id: "collection",
      status: "COMPLETED",
      finishedAt: "2026-10-28T12:00:00Z",
      entries: [{ id: "entry", sizeBytes: null }],
      progress: { successfulCount: 1 },
    });
    let observer: ((job: unknown) => Promise<void>) | undefined;
    const bridge = new WorkflowEventBridge(
      { record } as never,
      {
        registerCompletionObserver: (callback: typeof observer) => {
          observer = callback;
        },
      } as never,
      undefined,
      undefined,
      { buildData: { getCollection } as never },
    );
    bridge.start();
    try {
      agentEventBus.publish(BUILD_DATA_CHANGED_TOPIC, {
        buildDataCollectionChanged: { id: "collection" },
      });
      await vi.waitFor(() => expect(getCollection).toHaveBeenCalledTimes(1));
      expect(record).not.toHaveBeenCalled();
      getCollection.mockResolvedValue({
        id: "collection",
        status: "COMPLETED",
        finishedAt: "2026-10-28T12:00:00Z",
        entries: [{ id: "entry", sizeBytes: 10 }],
        progress: { successfulCount: 1 },
      });
      agentEventBus.publish(BUILD_DATA_CHANGED_TOPIC, {
        buildDataCollectionChanged: { id: "collection" },
      });
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      getCollection.mockResolvedValue({
        id: "collection",
        status: "COMPLETED",
        finishedAt: "2026-10-28T12:00:00Z",
        entries: [{ id: "entry", sizeBytes: 20 }],
        progress: { successfulCount: 1 },
      });
      agentEventBus.publish(BUILD_DATA_CHANGED_TOPIC, {
        buildDataCollectionChanged: { id: "collection" },
      });
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
      expect(record.mock.calls[0][0].dedupeKey).not.toBe(
        record.mock.calls[1][0].dedupeKey,
      );
      expect(
        record.mock.calls.every(
          ([input]) => input.kind === "BUILD_DATA_THRESHOLD",
        ),
      ).toBe(true);
      getCollection.mockResolvedValue({
        id: "collection",
        status: "COMPLETED",
        finishedAt: "2026-10-28T12:00:00Z",
        entries: [{ id: "entry", sizeBytes: 10 }],
        progress: { successfulCount: 1 },
      });
      agentEventBus.publish(BUILD_DATA_CHANGED_TOPIC, {
        buildDataCollectionChanged: { id: "collection" },
      });
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3));
      expect(record.mock.calls[2][0].dedupeKey).not.toBe(
        record.mock.calls[0][0].dedupeKey,
      );
      await observer?.({
        id: "delete-job",
        kind: "buildData.delete",
        status: "SUCCEEDED",
        error: null,
        agentId: "agent",
        codebaseId: null,
        worktreeId: null,
        buildDataCollectionId: "collection",
        resultJson: JSON.stringify({
          deleted: [{ path: "/derived/data", deleted: true, error: null }],
        }),
      });
      expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: "BUILD_DATA_CLEANUP_RESULT",
        payload: {
          cleanup: {
            jobId: "delete-job",
            status: "SUCCEEDED",
            deleted: [{ deleted: true }],
          },
        },
      });
    } finally {
      bridge.stop();
    }
  });
});
