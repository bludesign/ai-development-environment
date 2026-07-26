import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TerminalOutputCard } from "./terminal-output-card";

const scrollLines = vi.hoisted(() => vi.fn());
const buffer = vi.hoisted(() => ({
  active: { viewportY: 50, baseY: 100 },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    buffer = buffer;
    element: HTMLElement | null = null;
    rows = 20;
    loadAddon() {}
    open(parent: HTMLElement) {
      this.element = document.createElement("div");
      const screenElement = document.createElement("div");
      screenElement.className = "xterm-screen";
      screenElement.getBoundingClientRect = () => ({ height: 320 }) as DOMRect;
      this.element.appendChild(screenElement);
      parent.appendChild(this.element);
    }
    write(_value: string | Uint8Array, callback?: () => void) {
      callback?.();
    }
    onScroll() {
      return { dispose: vi.fn() };
    }
    scrollLines(lines: number) {
      scrollLines(lines);
      buffer.active.viewportY = Math.max(
        0,
        Math.min(buffer.active.baseY, buffer.active.viewportY + lines),
      );
    }
    scrollToBottom() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {
      return false;
    }
    findPrevious() {
      return false;
    }
    clearDecorations() {}
    onDidChangeResults() {
      return { dispose: vi.fn() };
    }
  },
}));

function outputCard() {
  return (
    <TerminalOutputCard
      ariaLabel="Terminal output"
      emptyText="No output"
      entries={[]}
      fitLabel="Fit terminal"
      followLabel="Follow output"
      nextMatchLabel="Next match"
      previousMatchLabel="Previous match"
      rawOutputHref="/en/commands/runs/run-1/output"
      rawOutputLabel="View raw output"
      searchLabel="Search terminal"
      sourceKey="run-1"
      title="Terminal output"
    />
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  buffer.active.viewportY = 50;
  buffer.active.baseY = 100;
  scrollLines.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("scrolls terminal history with a one-finger mobile gesture", async () => {
  render(outputCard());
  const terminal = screen.getByRole("log", { name: "Terminal output" });
  await waitFor(() =>
    expect(terminal.querySelector(".xterm-screen")).not.toBeNull(),
  );

  fireEvent.touchStart(terminal, { touches: [{ clientY: 200 }] });
  const move = new Event("touchmove", { bubbles: true, cancelable: true });
  Object.defineProperty(move, "touches", {
    value: [{ clientY: 152 }],
  });
  terminal.dispatchEvent(move);

  expect(scrollLines).toHaveBeenCalledWith(3);
  expect(move.defaultPrevented).toBe(true);
});

test("lets the page handle a gesture once the terminal reaches its boundary", async () => {
  buffer.active.viewportY = buffer.active.baseY;
  render(outputCard());
  const terminal = screen.getByRole("log", { name: "Terminal output" });
  await waitFor(() =>
    expect(terminal.querySelector(".xterm-screen")).not.toBeNull(),
  );

  fireEvent.touchStart(terminal, { touches: [{ clientY: 200 }] });
  const move = new Event("touchmove", { bubbles: true, cancelable: true });
  Object.defineProperty(move, "touches", {
    value: [{ clientY: 152 }],
  });
  terminal.dispatchEvent(move);

  expect(scrollLines).not.toHaveBeenCalled();
  expect(move.defaultPrevented).toBe(false);
});

test("places the raw output link immediately before the fit control", () => {
  render(outputCard());
  const rawOutput = screen.getByRole("link", { name: "View raw output" });
  const fit = screen.getByRole("button", { name: "Fit terminal" });

  expect(rawOutput.getAttribute("href")).toBe("/en/commands/runs/run-1/output");
  expect(
    rawOutput.compareDocumentPosition(fit) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
