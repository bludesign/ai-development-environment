import type { MouseEvent } from "react";

import type {
  WorktreeAgentGroup,
  WorktreeCodebaseGroup,
  WorktreeOverview,
} from "./types";

const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[data-worktree-navigation-ignore]",
].join(",");

export function worktreeDetailHref(worktreeId: string): string {
  return `/worktrees/${encodeURIComponent(worktreeId)}`;
}

export function shouldNavigateWorktreeSurface(
  event: MouseEvent<HTMLElement>,
): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  return !(event.target as HTMLElement).closest(INTERACTIVE_SELECTOR);
}

export type WorktreeOverviewEntry = {
  agentGroup: WorktreeAgentGroup;
  group: WorktreeCodebaseGroup;
  worktree: WorktreeCodebaseGroup["worktrees"][number];
};

export function findWorktreeOverviewEntry(
  overview: WorktreeOverview,
  worktreeId: string,
): WorktreeOverviewEntry | null {
  for (const agentGroup of overview.agents) {
    for (const group of agentGroup.codebases) {
      const worktree = group.worktrees.find((item) => item.id === worktreeId);
      if (worktree) return { agentGroup, group, worktree };
    }
  }
  return null;
}
