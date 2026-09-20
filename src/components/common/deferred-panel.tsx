"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/** Mount near the viewport, then retain the form and its unsaved state. */
export function DeferredPanel({ children }: { children: ReactNode }) {
  const target = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    if (typeof IntersectionObserver === "undefined") {
      const timer = window.setTimeout(() => setReady(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    if (target.current) observer.observe(target.current);
    return () => observer.disconnect();
  }, [ready]);
  return (
    <div ref={target}>
      {ready ? children : <Skeleton className="h-80 w-full rounded-xl" />}
    </div>
  );
}
