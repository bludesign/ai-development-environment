import { expect, test } from "vitest";
import { sequenceRanges } from "./sequence-ranges";

test("compresses received sequences while preserving missing ranges for reconciliation", () => {
  expect(sequenceRanges([9, 3, 0, 2, 3, 4, 8])).toEqual([
    { fromSequence: 0, throughSequence: 0 },
    { fromSequence: 2, throughSequence: 4 },
    { fromSequence: 8, throughSequence: 9 },
  ]);
  expect(sequenceRanges([])).toEqual([]);
});
