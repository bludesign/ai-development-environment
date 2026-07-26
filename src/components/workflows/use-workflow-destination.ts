"use client";

import { useCallback } from "react";

import { useRouter } from "@/i18n/navigation";
import type { WorkflowResourceDestination } from "@/lib/workflows/resources";

/**
 * Opens the resource a step produced. Every graph that shows a run — the full
 * run page as well as the compact card on a resource page — sends its step
 * clicks through here, so a step behaves the same wherever it is drawn.
 */
export function useOpenWorkflowDestination(): (
  destination: WorkflowResourceDestination | null,
) => void {
  const router = useRouter();
  return useCallback(
    (destination: WorkflowResourceDestination | null) => {
      if (!destination) return;
      if (destination.external) {
        window.open(destination.href, "_blank", "noopener,noreferrer");
        return;
      }
      router.push(destination.href);
    },
    [router],
  );
}
