import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  TerminalOutputCard,
  type TerminalOutputEntry,
} from "./terminal-output-card";

const state = vi.hoisted(() => ({
  terminals: [] as Terminal[],
  dimensions: { cols: 80, rows: 24 },
}));

// Exercise xterm's real parser, asynchronous write queue and scrollback buffer.
// Only DOM rendering and layout are replaced for jsdom.
vi.mock("@xterm/xterm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xterm/xterm")>();
  return {
    ...actual,
    Terminal: class extends actual.Terminal {
      open() {
        state.terminals.push(this);
      }
    },
  };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    terminal: Terminal | null = null;
    activate(terminal: Terminal) {
      this.terminal = terminal;
    }
    proposeDimensions() {
      return state.dimensions;
    }
    fit() {
      this.terminal?.resize(state.dimensions.cols, state.dimensions.rows);
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    activate() {}
    dispose() {}
    onDidChangeResults() {
      return { dispose() {} };
    }
  },
}));

function outputCard(entries: TerminalOutputEntry[]) {
  return (
    <TerminalOutputCard
      ariaLabel="Terminal output"
      emptyText="No output"
      entries={entries}
      fitLabel="Fit terminal"
      followLabel="Follow output"
      nextMatchLabel="Next match"
      previousMatchLabel="Previous match"
      searchLabel="Search terminal"
      sourceKey="buffer-test"
      title="Terminal output"
    />
  );
}

function entry(id: string, output: string): TerminalOutputEntry {
  return { id, data: new TextEncoder().encode(output) };
}

function cursorLine(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true);
}

beforeEach(() => {
  state.terminals.length = 0;
  state.dimensions = { cols: 80, rows: 24 };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("keeps capacity stable as byte-heavy output is appended", async () => {
  const chunk = `${"x".repeat(78)}\n`.repeat(100);
  let entries = Array.from({ length: 128 }, (_, index) =>
    entry(String(index), chunk),
  );
  entries.push(entry("end", "END"));
  const { rerender } = render(outputCard(entries));
  await waitFor(() => expect(state.terminals).toHaveLength(1));
  const terminal = state.terminals[0];
  await waitFor(() => expect(cursorLine(terminal)).toBe("END"));
  expect(terminal.options.scrollback).toBe(100_000);

  for (let index = 0; index < 10; index++) {
    entries = [...entries, entry(`append-${index}`, `\n${chunk}END-${index}`)];
    rerender(outputCard(entries));
    await waitFor(() => expect(cursorLine(terminal)).toBe(`END-${index}`));
    expect(terminal.options.scrollback).toBe(100_000);
  }
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe(
    "x".repeat(78),
  );
});

test("retains history while ANSI output expands beyond the initial capacity", async () => {
  const { rerender } = render(outputCard([]));
  await waitFor(() => expect(state.terminals).toHaveLength(1));
  const terminal = state.terminals[0];
  terminal.options.scrollback = 64;

  // REP expands a tiny input into hundreds of wrapped physical lines.
  rerender(outputCard([entry("expanded", "FIRST\r\nx\x1b[50000b\r\nEND")]));
  await waitFor(() => expect(cursorLine(terminal)).toBe("END"));
  expect(terminal.buffer.normal.length).toBeGreaterThan(600);
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe(
    "FIRST",
  );
  expect(terminal.options.scrollback).toBeLessThan(2_000);
});

test("reserves space before a narrower layout reflows existing history", async () => {
  const { rerender } = render(outputCard([]));
  await waitFor(() => expect(state.terminals).toHaveLength(1));
  const terminal = state.terminals[0];
  terminal.options.scrollback = 64;
  rerender(
    outputCard([
      entry("wide", `FIRST\r\n${`${"界".repeat(40)}\r\n`.repeat(60)}END`),
    ]),
  );
  await waitFor(() => expect(cursorLine(terminal)).toBe("END"));
  const previousCapacity = terminal.options.scrollback!;

  state.dimensions = { cols: 9, rows: 24 };
  fireEvent.click(screen.getByRole("button", { name: "Fit terminal" }));
  expect(terminal.cols).toBe(9);
  expect(terminal.buffer.normal.length).toBeGreaterThan(previousCapacity);
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe(
    "FIRST",
  );
  expect(cursorLine(terminal)).toBe("END");
});
