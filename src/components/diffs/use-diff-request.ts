"use client";

import { useEffect, useState } from "react";

import type { WorktreeFileDiff } from "@/components/worktrees/types";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { INSPECT_WORKTREE_DIFF_MUTATION } from "./diffs-graphql";
import type { DiffScope } from "./types";

/**
 * Selection changes are debounced by this much. Every request is a queued agent
 * job with a 30s timeout, so arrow-keying down the file list must not fire one
 * per keystroke.
 */
const DEBOUNCE_MS = 150;

export type DiffRequest = {
  worktreeId: string;
  scope: DiffScope;
  path: string | null;
  previousPath: string | null;
  commitSha: string | null;
};

/**
 * The cache key folds in `resetToken`, so bumping the token misses every prior
 * entry without having to clear the map — which would need an extra render to
 * take effect.
 */
function cacheKey(request: DiffRequest, resetToken: string): string {
  return JSON.stringify([
    resetToken,
    request.worktreeId,
    request.scope,
    request.commitSha ?? "",
    request.previousPath ?? "",
    request.path ?? "",
  ]);
}

/**
 * Loads a diff for the current selection, debounced and memoized.
 *
 * A diff is immutable for a given (worktree, scope, commit, path) tuple until
 * the working tree changes, so re-selecting a file the user just looked at is
 * served from memory rather than costing another agent round trip.
 *
 * Loading and cache hits are derived during render rather than pushed through
 * state, so the effect never calls setState synchronously.
 */
export function useDiffRequest(
  request: DiffRequest | null,
  resetToken: string = "",
) {
  // The cache lives in state rather than a ref so it can be read during render
  // and so a landed request re-renders without a separate signal.
  const [store, setStore] = useState<{
    resetToken: string;
    diffs: Map<string, WorktreeFileDiff>;
    errors: Map<string, string>;
  }>(() => ({ resetToken, diffs: new Map(), errors: new Map() }));

  const key = request ? cacheKey(request, resetToken) : null;
  const value = key ? (store.diffs.get(key) ?? null) : null;
  const error = key ? (store.errors.get(key) ?? null) : null;
  // Anything selected that is neither cached nor already failed is in flight.
  const loading = Boolean(key) && !value && !error;

  useEffect(() => {
    if (!request || !key || value || error) return;
    let disposed = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void controlPlaneRequest<{ inspectWorktreeDiff: WorktreeFileDiff }>(
        INSPECT_WORKTREE_DIFF_MUTATION,
        {
          input: {
            worktreeId: request.worktreeId,
            scope: request.scope,
            path: request.path,
            previousPath: request.previousPath,
            commitSha: request.commitSha,
            requestId: createClientId(),
          },
        },
        { signal: controller.signal, cancelBeforeDispatch: true },
      )
        .then((data) => {
          if (disposed) return;
          setStore((current) => {
            const sameRevision = current.resetToken === resetToken;
            const diffs = new Map(sameRevision ? current.diffs : []);
            diffs.set(key, data.inspectWorktreeDiff);
            if (diffs.size > 50) diffs.delete(diffs.keys().next().value!);
            return {
              resetToken,
              diffs,
              errors: sameRevision ? current.errors : new Map(),
            };
          });
        })
        .catch((reason) => {
          if (disposed) return;
          setStore((current) => {
            const sameRevision = current.resetToken === resetToken;
            const errors = new Map(sameRevision ? current.errors : []);
            errors.set(
              key,
              reason instanceof Error ? reason.message : String(reason),
            );
            if (errors.size > 50) errors.delete(errors.keys().next().value!);
            return {
              resetToken,
              errors,
              diffs: sameRevision ? current.diffs : new Map(),
            };
          });
        });
    }, DEBOUNCE_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timer);
    };
    // `key` fully describes the request; the object identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { value, loading, error };
}
