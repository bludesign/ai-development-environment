"use client";

import { useEffect, useState } from "react";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { ProviderCatalogEntry } from "./model-effort-picker";

const CATALOG_QUERY = `query RunProviderCatalog($worktreeId: ID) {
  runProviderCatalog(worktreeId: $worktreeId) {
    key
    label
    available
    supportsWebSearch
    models { id label efforts group }
  }
}`;

/**
 * Fetches the run provider catalog — the same list of providers, models, and
 * efforts the start-session picker uses. A literal `worktreeId` scopes the
 * catalog to that worktree's online agent; pass null for the unscoped catalog.
 * Errors degrade to an empty catalog, which the picker renders as "choose a
 * model" rather than surfacing a fetch failure inside a config form.
 */
export function useProviderCatalog(
  worktreeId: string | null,
): ProviderCatalogEntry[] {
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void controlPlaneRequest<{ runProviderCatalog: ProviderCatalogEntry[] }>(
      CATALOG_QUERY,
      { worktreeId: worktreeId || null },
    )
      .then((data) => {
        if (!cancelled) setCatalog(data.runProviderCatalog);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeId]);
  return catalog;
}
