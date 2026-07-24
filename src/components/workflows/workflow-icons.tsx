import {
  Blocks,
  Bot,
  CalendarClock,
  CircleCheckBig,
  ClipboardList,
  Cpu,
  FolderGit2,
  GitBranch,
  GitFork,
  GitPullRequest,
  Hammer,
  MousePointerClick,
  Play,
  Sparkles,
  Split,
  TicketCheck,
  UserRoundCheck,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import {
  WORKFLOW_STEP_BY_KIND,
  WORKFLOW_TRIGGER_BY_KIND,
} from "@/lib/workflows/definition";

/**
 * One icon per catalog group, reusing whatever the sidebar already uses for
 * that domain so a Jira step on the canvas reads the same as the Jira page in
 * the nav. Keyed by the category strings in
 * `WORKFLOW_STEP_CATALOG`/`WORKFLOW_TRIGGER_CATALOG` — a group added there
 * without an entry here falls back to the generic step or trigger icon rather
 * than breaking the card.
 */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Agents: Cpu,
  "AI runs": Bot,
  Builds: Hammer,
  Codebases: FolderGit2,
  "Control flow": Split,
  Extensibility: Blocks,
  GitHub: GitPullRequest,
  "GitHub Actions": CircleCheckBig,
  "Human loop": UserRoundCheck,
  Jira: TicketCheck,
  Manual: MousePointerClick,
  "Plans and sessions": ClipboardList,
  Schedule: CalendarClock,
  Skills: Sparkles,
  Workflows: Waypoints,
  Worktrees: GitBranch,
};

/**
 * The catalog category for a step or trigger kind. The graph is rendered on
 * pages that never load the GraphQL catalog (a published run, a workflow
 * overview), so it resolves against the same in-process catalog the server
 * serves rather than requiring the caller to pass a lookup.
 */
export function workflowCategory(kind: string, trigger: boolean): string {
  const entry = trigger
    ? WORKFLOW_TRIGGER_BY_KIND.get(kind as never)
    : WORKFLOW_STEP_BY_KIND.get(kind as never);
  return entry?.category ?? (trigger ? "Trigger" : "Step");
}

export function WorkflowCategoryIcon({
  category,
  className,
  trigger,
}: {
  category: string;
  className?: string;
  trigger: boolean;
}) {
  const Icon = CATEGORY_ICONS[category] ?? (trigger ? Play : GitFork);
  return <Icon className={className} />;
}
