import { describe, expect, test } from "vitest";
import { observeDirtyDuration } from "./dirty-duration";

describe("continuous dirty duration", () => {
  test("ignores clean worktrees and fires once per continuously dirty interval", () => {
    const clean = observeDirtyDuration({
      dirty: false,
      now: 1000,
      durationSeconds: 60,
    });
    expect(clean).toMatchObject({ cursor: { dirtySince: null }, fire: false });
    const first = observeDirtyDuration({
      dirty: true,
      now: 2000,
      durationSeconds: 60,
    });
    expect(first.fire).toBe(false);
    const polling = observeDirtyDuration({
      dirty: true,
      now: 61000,
      durationSeconds: 60,
      previousCursor: first.cursor,
    });
    expect(polling.cursor.dirtySince).toBe(2000);
    expect(polling.fire).toBe(false);
    const elapsed = observeDirtyDuration({
      dirty: true,
      now: 62000,
      durationSeconds: 60,
      previousCursor: polling.cursor,
    });
    expect(elapsed.fire).toBe(true);
    expect(
      observeDirtyDuration({
        dirty: true,
        now: 90000,
        durationSeconds: 60,
        previousCursor: elapsed.cursor,
        previouslyMatched: true,
      }).fire,
    ).toBe(false);
    const reset = observeDirtyDuration({
      dirty: false,
      now: 91000,
      previousCursor: elapsed.cursor,
      previouslyMatched: true,
    });
    expect(reset.matched).toBe(false);
    expect(
      observeDirtyDuration({
        dirty: true,
        now: 92000,
        previousCursor: reset.cursor,
      }).cursor.dirtySince,
    ).toBe(92000);
  });

  test("migrates the previous timestamp cursor without premature firing and rejects invalid durations", () => {
    expect(
      observeDirtyDuration({
        dirty: true,
        now: 90000,
        previousCursor: { value: "2026-01-01" },
      }).cursor.dirtySince,
    ).toBe(90000);
    for (const durationSeconds of [0, -1, 1.5, Infinity, "60", 31536001]) {
      expect(() =>
        observeDirtyDuration({ dirty: true, now: 0, durationSeconds }),
      ).toThrow("Dirty duration");
    }
  });
});
