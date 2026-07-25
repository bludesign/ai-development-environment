"use client";

import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type TerminalOutputEntry = {
  id: string;
  data: Uint8Array;
  divider?: string;
  dividerKey?: string;
};

export function decodeTerminalBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const SEARCH_OPTIONS = {
  incremental: true,
  decorations: {
    matchBackground: "#713f12",
    matchOverviewRuler: "#f59e0b",
    activeMatchBackground: "#f59e0b",
    activeMatchColorOverviewRuler: "#fbbf24",
  },
} as const;

export function TerminalOutputCard({
  sourceKey,
  title,
  entries,
  emptyText,
  followLabel,
  fitLabel,
  searchLabel,
  previousMatchLabel,
  nextMatchLabel,
  ariaLabel,
  open = true,
  onOpenChange,
  collapseLabel,
  expandLabel,
  className,
}: {
  sourceKey: string;
  title: string;
  entries: TerminalOutputEntry[];
  emptyText: string;
  followLabel: string;
  fitLabel: string;
  searchLabel: string;
  previousMatchLabel: string;
  nextMatchLabel: string;
  ariaLabel: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseLabel?: string;
  expandLabel?: string;
  className?: string;
}) {
  const [terminalElement, setTerminalElement] = useState<HTMLDivElement | null>(
    null,
  );
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const searchRef = useRef<import("@xterm/addon-search").SearchAddon | null>(
    null,
  );
  const entriesRef = useRef(entries);
  const writtenRef = useRef(new Set<string>());
  const dividerRef = useRef<string | null>(null);
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);
  const searchTermRef = useRef("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState({
    resultIndex: -1,
    resultCount: 0,
  });

  const search = useCallback(
    (term: string, direction: "next" | "previous" = "next") => {
      searchTermRef.current = term;
      setSearchTerm(term);
      const addon = searchRef.current;
      if (!term) {
        addon?.clearDecorations();
        setSearchResults({ resultIndex: -1, resultCount: 0 });
        return;
      }
      if (direction === "previous") {
        addon?.findPrevious(term, SEARCH_OPTIONS);
      } else {
        addon?.findNext(term, SEARCH_OPTIONS);
      }
    },
    [],
  );

  const writeEntries = useCallback((nextEntries: TerminalOutputEntry[]) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    // Catch-up queries can insert a late chunk before entries already shown.
    // Keep the live terminal stable and append only that unseen chunk; a new
    // terminal lifecycle still replays the complete canonical entry order.
    for (const entry of nextEntries) {
      if (writtenRef.current.has(entry.id)) continue;
      const hasRenderedEntries = writtenRef.current.size > 0;
      writtenRef.current.add(entry.id);
      const dividerKey = entry.dividerKey ?? entry.divider;
      if (entry.divider && dividerKey !== dividerRef.current) {
        dividerRef.current = dividerKey ?? null;
        // The blank line separates a divider from the block above it, so the
        // first divider skips it and stays flush with the top of the terminal.
        const lead = hasRenderedEntries ? "\r\n" : "";
        terminal.write(`${lead}\x1b[90m── ${entry.divider} ──\x1b[0m\r\n`);
      }
      terminal.write(entry.data, () => {
        if (followRef.current) terminal.scrollToBottom();
      });
    }
  }, []);

  useEffect(() => {
    entriesRef.current = entries;
    writeEntries(entries);
  }, [entries, writeEntries]);

  useEffect(() => {
    if (!terminalElement || !open) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let scrollDisposable: { dispose(): void } | null = null;
    let searchDisposable: { dispose(): void } | null = null;
    writtenRef.current.clear();
    dividerRef.current = null;
    followRef.current = true;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]).then(([{ Terminal }, { FitAddon }, { SearchAddon }]) => {
      if (cancelled) return;
      setFollow(true);
      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        scrollback: 100_000,
        theme: {
          background: "#09090b",
          foreground: "#fafafa",
          cursor: "#a1a1aa",
          selectionBackground: "#3f3f46",
        },
      });
      const fit = new FitAddon();
      const searchAddon = new SearchAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(searchAddon);
      terminal.open(terminalElement);
      fit.fit();
      terminalRef.current = terminal;
      fitRef.current = fit;
      searchRef.current = searchAddon;
      searchDisposable = searchAddon.onDidChangeResults((results) =>
        setSearchResults(results),
      );
      scrollDisposable = terminal.onScroll(() => {
        const atBottom =
          terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        followRef.current = atBottom;
        setFollow(atBottom);
      });
      observer = new ResizeObserver(() => fit.fit());
      observer.observe(terminalElement);
      writeEntries(entriesRef.current);
      if (searchTermRef.current) {
        searchAddon.findNext(searchTermRef.current, SEARCH_OPTIONS);
      }
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      scrollDisposable?.dispose();
      searchDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [open, sourceKey, terminalElement, writeEntries]);

  const searchResultLabel = searchResults.resultCount
    ? `${Math.max(0, searchResults.resultIndex + 1)}/${searchResults.resultCount}`
    : "0/0";

  return (
    <Card className={cn("gap-0 py-0", className)}>
      <CardHeader>
        <CardTitle className="min-w-0">
          {onOpenChange ? (
            <Button
              aria-expanded={open}
              className="-mx-2 -my-1 h-auto w-full min-w-0 justify-start px-2 py-1 font-heading text-base leading-snug font-medium aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:bg-transparent dark:aria-expanded:hover:bg-muted/50"
              onClick={() => onOpenChange(!open)}
              type="button"
              variant="ghost"
            >
              <span className="truncate">{title}</span>
            </Button>
          ) : (
            title
          )}
        </CardTitle>
        <CardAction className="flex items-center gap-2">
          {open && (
            <div className="flex items-center gap-1">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label={searchLabel}
                  className="h-7 w-36 pr-10 pl-7 text-xs sm:w-52"
                  onChange={(event) => search(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      search(searchTerm, event.shiftKey ? "previous" : "next");
                    } else if (event.key === "Escape") {
                      search("");
                    }
                  }}
                  placeholder={searchLabel}
                  type="search"
                  value={searchTerm}
                />
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground tabular-nums">
                  {searchResultLabel}
                </span>
              </div>
              <Button
                aria-label={previousMatchLabel}
                disabled={!searchTerm || searchResults.resultCount === 0}
                onClick={() => search(searchTerm, "previous")}
                size="icon-sm"
                title={previousMatchLabel}
                type="button"
                variant="ghost"
              >
                <ChevronUp />
              </Button>
              <Button
                aria-label={nextMatchLabel}
                disabled={!searchTerm || searchResults.resultCount === 0}
                onClick={() => search(searchTerm)}
                size="icon-sm"
                title={nextMatchLabel}
                type="button"
                variant="ghost"
              >
                <ChevronDown />
              </Button>
            </div>
          )}
          {open && !follow && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                followRef.current = true;
                setFollow(true);
                terminalRef.current?.scrollToBottom();
              }}
            >
              {followLabel}
            </Button>
          )}
          {open && (
            <Button
              aria-label={fitLabel}
              size="icon-sm"
              title={fitLabel}
              variant="outline"
              onClick={() => fitRef.current?.fit()}
            >
              <RefreshCw />
            </Button>
          )}
          {onOpenChange && (
            <Button
              aria-expanded={open}
              aria-label={open ? collapseLabel : expandLabel}
              className="aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:bg-transparent dark:aria-expanded:hover:bg-muted/50"
              onClick={() => onOpenChange(!open)}
              size="icon-sm"
              title={open ? collapseLabel : expandLabel}
              type="button"
              variant="ghost"
            >
              {open ? (
                <ChevronDown className="size-5" />
              ) : (
                <ChevronRight className="size-5" />
              )}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      {open && (
        <div className="relative bg-[#09090b]">
          <div
            aria-label={ariaLabel}
            className="h-[min(60vh,42rem)] px-2 pb-2"
            ref={setTerminalElement}
            role="log"
          />
          {!entries.length && (
            <p className="pointer-events-none absolute inset-0 p-4 font-mono text-xs text-neutral-400">
              {emptyText}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
