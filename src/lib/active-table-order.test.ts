import { describe, expect, test } from "vitest";

import {
  hasPrioritizedTableStatus,
  prioritizeActiveTableRows,
} from "./active-table-order";

describe("active table ordering", () => {
  test.each(["RUNNING", "BLOCKED", "PAUSED", "WAITING", "IN_PROGRESS"])(
    "prioritizes %s",
    (status) => {
      expect(hasPrioritizedTableStatus(status)).toBe(true);
    },
  );

  test("moves active rows first without changing order within either tier", () => {
    const rows = [
      { id: "newest-complete", status: "COMPLETED" },
      { id: "waiting", status: "WAITING" },
      { id: "older-complete", status: "SUCCEEDED" },
      { id: "running", status: "RUNNING" },
      { id: "failed", status: "FAILED" },
    ];

    expect(prioritizeActiveTableRows(rows).map(({ id }) => id)).toEqual([
      "waiting",
      "running",
      "newest-complete",
      "older-complete",
      "failed",
    ]);
    expect(rows[0]?.id).toBe("newest-complete");
  });
});
