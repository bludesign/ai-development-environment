import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { QuickActionsRow } from "./quick-actions-row";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** jsdom reports every rect as zero, so lay the groups out by their text content instead. */
function stubLayout(rows: Record<string, { top: number; bottom: number }>) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const row = rows[this.textContent ?? ""];
      return {
        ...new DOMRect(
          0,
          row?.top ?? 0,
          100,
          (row?.bottom ?? 0) - (row?.top ?? 0),
        ),
        top: row?.top ?? 0,
        bottom: row?.bottom ?? 0,
      } as DOMRect;
    },
  );
}

describe("QuickActionsRow", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  test("separates both groups when they share a line", () => {
    stubLayout({
      Workflows: { top: 0, bottom: 32 },
      Commands: { top: 0, bottom: 32 },
    });
    const { container } = render(
      <QuickActionsRow
        first={<div>Workflows</div>}
        second={<div>Commands</div>}
      />,
    );
    const separator = container.querySelector("[data-quick-actions-separator]");
    expect(separator).not.toBeNull();
    expect(separator?.className).not.toContain("invisible");
  });

  test("keeps the separator out of sight when the groups wrap", () => {
    stubLayout({
      Workflows: { top: 0, bottom: 32 },
      Commands: { top: 40, bottom: 72 },
    });
    const { container } = render(
      <QuickActionsRow
        first={<div>Workflows</div>}
        second={<div>Commands</div>}
      />,
    );
    const separator = container.querySelector("[data-quick-actions-separator]");
    expect(separator).not.toBeNull();
    expect(separator?.className).toContain("invisible");
  });

  test("omits the separator when only one group has actions", () => {
    stubLayout({ Commands: { top: 0, bottom: 32 } });
    const { container } = render(
      <QuickActionsRow first={null} second={<div>Commands</div>} />,
    );
    expect(
      container.querySelector("[data-quick-actions-separator]"),
    ).toBeNull();
  });
});
