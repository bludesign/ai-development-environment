import { describe, expect, test, vi } from "vitest";
import { readCursorWindow } from "./read-cursor-window";

describe("readCursorWindow", () => {
  test("retains loaded rows beyond the server limit without requesting oversized pages", async () => {
    const source = Array.from({ length: 480 }, (_, i) => ({ id: String(i) }));
    const load = vi.fn(async (after: string | null, first: number) => {
      const offset = after === null ? 0 : Number(after);
      return {
        items: source.slice(offset, offset + first),
        nextCursor:
          offset + first < source.length ? String(offset + first) : null,
        totalCount: 480,
      };
    });
    const result = await readCursorWindow(
      load,
      450,
      200,
      (row: { id: string }) => row.id,
    );
    expect(load.mock.calls).toEqual([
      [null, 200],
      ["200", 200],
      ["400", 50],
    ]);
    expect(result.items).toHaveLength(450);
    expect(result.nextCursor).toBe("450");
    expect(result.totalCount).toBe(480);
  });
  test("deduplicates overlapping pages and fills the requested window", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: "a" }, { id: "b" }],
        nextCursor: "b",
      })
      .mockResolvedValueOnce({
        items: [{ id: "b" }, { id: "c" }],
        nextCursor: "c",
      })
      .mockResolvedValueOnce({ items: [{ id: "d" }], nextCursor: null });
    const result = await readCursorWindow<
      { id: string },
      { items: { id: string }[]; nextCursor: string | null }
    >(load, 4, 2, (row: { id: string }) => row.id);
    expect(result.items.map((row: { id: string }) => row.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(load).toHaveBeenLastCalledWith("c", 1);
  });
  test("rejects a repeated cursor instead of looping forever", async () => {
    const load = vi.fn(async () => ({ items: [{ id: "a" }], nextCursor: "a" }));
    await expect(
      readCursorWindow(load, 3, 2, (row: { id: string }) => row.id),
    ).rejects.toThrow("repeated pagination cursor");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
