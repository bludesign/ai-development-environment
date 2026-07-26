"use client";

import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
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
  rawOutputHref,
  rawOutputLabel,
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
  rawOutputHref?: string;
  rawOutputLabel?: string;
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
    let lastTouchY: number | null = null;
    let touchRemainder = 0;
    let resetTouch: (() => void) | null = null;
    let handleTouchStart: ((event: TouchEvent) => void) | null = null;
    let handleTouchMove: ((event: TouchEvent) => void) | null = null;
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

      resetTouch = () => {
        lastTouchY = null;
        touchRemainder = 0;
      };
      handleTouchStart = (event: TouchEvent) => {
        if (event.touches.length !== 1) {
          resetTouch?.();
          return;
        }
        lastTouchY = event.touches[0].clientY;
        touchRemainder = 0;
      };
      handleTouchMove = (event: TouchEvent) => {
        if (lastTouchY === null || event.touches.length !== 1) return;
        const currentY = event.touches[0].clientY;
        const delta = lastTouchY - currentY;
        lastTouchY = currentY;
        const buffer = terminal.buffer.active;
        const canScroll =
          (delta > 0 && buffer.viewportY < buffer.baseY) ||
          (delta < 0 && buffer.viewportY > 0);
        if (!canScroll) {
          touchRemainder = 0;
          return;
        }

        touchRemainder += delta;
        const screenHeight =
          terminal.element
            ?.querySelector<HTMLElement>(".xterm-screen")
            ?.getBoundingClientRect().height ?? 0;
        const lineHeight =
          screenHeight > 0 && terminal.rows > 0
            ? screenHeight / terminal.rows
            : 16;
        const lines =
          touchRemainder > 0
            ? Math.floor(touchRemainder / lineHeight)
            : Math.ceil(touchRemainder / lineHeight);
        if (lines) {
          terminal.scrollLines(lines);
          touchRemainder -= lines * lineHeight;
        }
        event.preventDefault();
        event.stopPropagation();
      };
      terminalElement.addEventListener("touchstart", handleTouchStart, {
        passive: true,
      });
      terminalElement.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      terminalElement.addEventListener("touchend", resetTouch, {
        passive: true,
      });
      terminalElement.addEventListener("touchcancel", resetTouch, {
        passive: true,
      });
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
      if (handleTouchStart)
        terminalElement.removeEventListener("touchstart", handleTouchStart);
      if (handleTouchMove)
        terminalElement.removeEventListener("touchmove", handleTouchMove);
      if (resetTouch) {
        terminalElement.removeEventListener("touchend", resetTouch);
        terminalElement.removeEventListener("touchcancel", resetTouch);
      }
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
      <CardHeader className="grid-cols-1 has-data-[slot=card-action]:grid-cols-1 @md/card-header:has-data-[slot=card-action]:grid-cols-[1fr_auto]">
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
        <CardAction className="col-start-1 row-span-1 row-start-2 flex max-w-full flex-wrap items-center justify-start gap-1 justify-self-start @md/card-header:col-start-2 @md/card-header:row-span-2 @md/card-header:row-start-1 @md/card-header:justify-end @md/card-header:justify-self-end">
          {open && (
            <div className="flex items-center gap-1">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label={searchLabel}
                  className="h-7 w-28 pr-10 pl-7 text-xs sm:w-52"
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
          {open && rawOutputHref && rawOutputLabel && (
            <Button asChild size="icon-sm" variant="outline">
              <a
                aria-label={rawOutputLabel}
                href={rawOutputHref}
                title={rawOutputLabel}
              >
                <Download />
              </a>
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
            className="h-[min(60dvh,42rem)] px-2 pb-2"
            ref={setTerminalElement}
            role="log"
          />
          {!entries.length && (
            <p className="pointer-events-none absolute inset-0 p-4 font-mono text-xs text-neutral-400">
              {emptyText}
            </p>
          )}
          {!follow && (
            <Button
              aria-label={followLabel}
              className="absolute right-4 bottom-4 z-10 border-white/15 bg-neutral-800/70 text-white shadow-lg backdrop-blur-sm hover:bg-neutral-700/90 hover:text-white"
              onClick={() => {
                followRef.current = true;
                setFollow(true);
                terminalRef.current?.scrollToBottom();
              }}
              size="icon"
              title={followLabel}
              type="button"
              variant="outline"
            >
              <ArrowDown />
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
