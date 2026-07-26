import { describe, expect, test } from "vitest";

import {
  aggregatePipelineStatus,
  normalizePipelineState,
  pipelineIdentity,
  shouldReplacePipelineRecord,
} from "./pipeline-status";

describe("GitHub pipeline status rules", () => {
  test.each([
    [["SUCCESS", "ERROR"], null, "ERROR"],
    [["SUCCESS", "TIMED_OUT"], null, "FAILURE"],
    [["SUCCESS", "IN_PROGRESS"], null, "PENDING"],
    [[], "EXPECTED", "EXPECTED"],
    [["SUCCESS", "NEUTRAL", "SKIPPED"], null, "SUCCESS"],
    [[], null, "NONE"],
  ] as const)("aggregates %j with rollup %s", (states, rollup, expected) => {
    expect(aggregatePipelineStatus([...states], rollup)).toBe(expected);
  });

  test("normalizes REST, GraphQL, and webhook states without inventing success", () => {
    expect(normalizePipelineState("completed", "failure")).toBe("FAILURE");
    expect(normalizePipelineState("completed", null)).toBe("NONE");
    expect(normalizePipelineState("waiting")).toBe("QUEUED");
    expect(normalizePipelineState("in_progress")).toBe("IN_PROGRESS");
  });

  test("prefers check-suite identity, then workflow run, then exact context", () => {
    expect(
      pipelineIdentity({
        id: "check-run-1",
        checkSuiteId: "suite-1",
        workflowRunId: "run-1",
      }),
    ).toBe("CHECK_SUITE:suite-1");
    expect(pipelineIdentity({ id: "run-1", workflowRunId: "run-1" })).toBe(
      "WORKFLOW_RUN:run-1",
    );
    expect(
      pipelineIdentity({ id: "status-1", statusContext: "deploy/production" }),
    ).toBe("STATUS_CONTEXT:deploy/production");
  });

  test("orders observations by attempt, GitHub timestamp, then source", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const current = {
      runAttempt: 1,
      githubUpdatedAt: new Date("2026-07-26T11:00:00.000Z"),
      source: "REST" as const,
      optimisticUntil: null,
    };
    expect(
      shouldReplacePipelineRecord(
        current,
        {
          runAttempt: 2,
          githubUpdatedAt: new Date("2026-07-26T10:00:00.000Z"),
          source: "GRAPHQL",
        },
        now,
      ),
    ).toBe(true);
    expect(
      shouldReplacePipelineRecord(
        current,
        {
          runAttempt: 1,
          githubUpdatedAt: new Date("2026-07-26T11:30:00.000Z"),
          source: "GRAPHQL",
        },
        now,
      ),
    ).toBe(true);
    expect(
      shouldReplacePipelineRecord(
        current,
        {
          runAttempt: 1,
          githubUpdatedAt: current.githubUpdatedAt,
          source: "WEBHOOK",
        },
        now,
      ),
    ).toBe(true);
    expect(
      shouldReplacePipelineRecord(
        { ...current, source: "WEBHOOK" },
        {
          runAttempt: 1,
          githubUpdatedAt: current.githubUpdatedAt,
          source: "GRAPHQL",
        },
        now,
      ),
    ).toBe(false);
  });

  test("protects optimistic mutations only from older or equal observations", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const optimistic = {
      runAttempt: 1,
      githubUpdatedAt: new Date("2026-07-26T11:00:00.000Z"),
      source: "MUTATION" as const,
      optimisticUntil: new Date("2026-07-26T12:02:00.000Z"),
    };
    expect(
      shouldReplacePipelineRecord(
        optimistic,
        {
          runAttempt: 1,
          githubUpdatedAt: optimistic.githubUpdatedAt,
          source: "WEBHOOK",
        },
        now,
      ),
    ).toBe(false);
    expect(
      shouldReplacePipelineRecord(
        optimistic,
        {
          runAttempt: 1,
          githubUpdatedAt: new Date("2026-07-26T11:01:00.000Z"),
          source: "REST",
        },
        now,
      ),
    ).toBe(true);
    expect(
      shouldReplacePipelineRecord(
        {
          ...optimistic,
          optimisticUntil: new Date("2026-07-26T11:59:00.000Z"),
        },
        {
          runAttempt: 1,
          githubUpdatedAt: optimistic.githubUpdatedAt,
          source: "GRAPHQL",
        },
        now,
      ),
    ).toBe(true);
  });

  test("does not regress a terminal webhook result with an equal-timestamp child update", () => {
    const githubUpdatedAt = new Date("2026-07-26T11:00:00.000Z");
    const now = new Date("2026-07-26T12:00:00.000Z");
    const terminal = {
      runAttempt: 1,
      githubUpdatedAt,
      source: "WEBHOOK" as const,
      optimisticUntil: null,
      status: "SUCCESS" as const,
    };

    expect(
      shouldReplacePipelineRecord(
        terminal,
        {
          runAttempt: 1,
          githubUpdatedAt,
          source: "WEBHOOK",
          status: "IN_PROGRESS",
        },
        now,
      ),
    ).toBe(false);
    expect(
      shouldReplacePipelineRecord(
        { ...terminal, status: "IN_PROGRESS" },
        {
          runAttempt: 1,
          githubUpdatedAt,
          source: "WEBHOOK",
          status: "SUCCESS",
        },
        now,
      ),
    ).toBe(true);
  });

  test("allows a terminal REST observation to heal an equal-timestamp pending webhook", () => {
    const githubUpdatedAt = new Date("2026-07-26T11:00:00.000Z");
    expect(
      shouldReplacePipelineRecord(
        {
          runAttempt: 1,
          githubUpdatedAt,
          source: "WEBHOOK",
          optimisticUntil: null,
          status: "IN_PROGRESS",
        },
        {
          runAttempt: 1,
          githubUpdatedAt,
          source: "REST",
          status: "SUCCESS",
        },
        new Date("2026-07-26T12:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
