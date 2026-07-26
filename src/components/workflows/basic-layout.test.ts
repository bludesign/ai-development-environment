import { describe, expect, test } from "vitest";

import { basicWorkflowLayout } from "./basic-layout";

const item = (id: string, x: number, y: number) => ({
  id,
  position: { x, y },
  width: 100,
  height: 50,
});

describe("basicWorkflowLayout", () => {
  test("lays a linear workflow left to right", () => {
    const result = basicWorkflowLayout(
      [item("trigger", 0, 0), item("step", 200, 0), item("done", 400, 0)],
      [
        { source: "trigger", target: "step" },
        { source: "step", target: "done" },
      ],
      "HORIZONTAL",
    );

    expect(result.positions.get("trigger")!.x).toBeLessThan(
      result.positions.get("step")!.x,
    );
    expect(result.positions.get("step")!.x).toBeLessThan(
      result.positions.get("done")!.x,
    );
  });

  test("groups branches and uses authored vertical order as the tie breaker", () => {
    const result = basicWorkflowLayout(
      [
        item("trigger", 0, 100),
        item("lower", 200, 300),
        item("upper", 200, 20),
        item("join", 400, 100),
      ],
      [
        { source: "trigger", target: "lower" },
        { source: "trigger", target: "upper" },
        { source: "lower", target: "join" },
        { source: "upper", target: "join" },
      ],
      "HORIZONTAL",
    );

    expect(result.positions.get("upper")!.x).toBe(
      result.positions.get("lower")!.x,
    );
    expect(result.positions.get("upper")!.y).toBeLessThan(
      result.positions.get("lower")!.y,
    );
  });

  test("turns the full flow into one ordered column on narrow screens", () => {
    const result = basicWorkflowLayout(
      [
        item("trigger", 0, 0),
        { ...item("left", 200, 0), width: 180 },
        item("right", 200, 100),
      ],
      [
        { source: "trigger", target: "left" },
        { source: "trigger", target: "right" },
      ],
      "VERTICAL",
    );

    expect(result.positions.get("trigger")!.y).toBeLessThan(
      result.positions.get("left")!.y,
    );
    expect(result.positions.get("left")!.y).toBeLessThan(
      result.positions.get("right")!.y,
    );
    expect(result.positions.get("left")!.x + 180 / 2).toBe(
      result.positions.get("right")!.x + 100 / 2,
    );
    expect(result.positions.get("left")!.x + 180).toBeLessThanOrEqual(
      result.bounds.width,
    );
    expect(result.positions.get("right")!.x + 100).toBeLessThanOrEqual(
      result.bounds.width,
    );
  });

  test("keeps cycle members visible in a trailing layer", () => {
    const result = basicWorkflowLayout(
      [item("trigger", 0, 0), item("first", 200, 0), item("second", 400, 0)],
      [
        { source: "first", target: "second" },
        { source: "second", target: "first" },
      ],
      "HORIZONTAL",
    );

    expect(result.positions.size).toBe(3);
    expect(result.positions.get("first")!.x).toBe(
      result.positions.get("second")!.x,
    );
  });
});
