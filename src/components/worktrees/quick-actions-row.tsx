"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Puts two quick-action groups on one line, divided by a separator, and falls back to one group
 * per line when they cannot share one.
 *
 * Either group renders nothing when it has no actions, and both load their actions after mount, so
 * the layout is measured from the DOM instead of the props. The separator is mounted only when both
 * groups are present, and it keeps its space while hidden so the measurement cannot flip-flop
 * between fitting and wrapping.
 */
export function QuickActionsRow({
  first,
  second,
}: {
  first: ReactNode;
  second: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ paired: false, inline: false });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const groups = [...container.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          child.dataset.quickActionsSeparator === undefined,
      );
      const paired = groups.length === 2;
      const [top, bottom] = groups;
      const inline =
        paired &&
        top!.getBoundingClientRect().bottom >
          bottom!.getBoundingClientRect().top;
      setLayout((current) =>
        current.paired === paired && current.inline === inline
          ? current
          : { paired, inline },
      );
    };
    measure();
    // Resizing catches wrapping; a group that mounts beside its neighbour leaves the container the
    // same size, so its arrival is only visible as a mutation.
    const resize = new ResizeObserver(measure);
    resize.observe(container);
    for (const child of container.children) resize.observe(child);
    const mutations = new MutationObserver(measure);
    mutations.observe(container, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  });
  return (
    <div
      className="flex w-full flex-wrap items-center gap-2"
      ref={containerRef}
    >
      {first}
      {layout.paired && (
        <Separator
          className={cn(!layout.inline && "invisible")}
          data-quick-actions-separator=""
          orientation="vertical"
        />
      )}
      {second}
    </div>
  );
}
