"use client";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import { readCursorWindow } from "@/lib/read-cursor-window";
import { BUILD_LIST_FIELDS } from "./graphql-fields";
import type { BuildRecord } from "./types";
export type BuildHistoryPage = {
  items: BuildRecord[];
  nextCursor: string | null;
};

/** Reconcile beyond the server's page cap without discarding an expanded history. */
export function readWorktreeBuildWindow(
  worktreeId: string,
  initial: BuildHistoryPage,
  count: number,
  signal: AbortSignal,
) {
  return readCursorWindow<BuildRecord, BuildHistoryPage>(
    async (after, first) => {
      if (!after) return initial;
      const data = await controlPlaneRequest<{ builds: BuildHistoryPage }>(
        `query WorktreeBuildHistoryWindow($worktreeId: ID!, $after: ID, $first: Int!) { builds(worktreeId: $worktreeId, after: $after, first: $first) { items { ${BUILD_LIST_FIELDS} } nextCursor } }`,
        { worktreeId, after, first },
        { signal },
      );
      return data.builds;
    },
    count,
    200,
    (build) => build.id,
  );
}
