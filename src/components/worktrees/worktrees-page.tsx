"use client";

import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Grid2X2,
  List,
  MoreHorizontal,
  Paintbrush,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Tags,
  Trash2,
  Upload,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import { PipelineMenu } from "@/components/github/pipeline-menu";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/ui/searchable-select";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/navigation";

import {
  WorktreeBranchForm,
  type WorktreeBranchSelection,
  type WorktreeBranchTarget,
} from "./worktree-branch-form";
import { waitForWorktreeJob } from "./worktree-jobs";

import type {
  Worktree,
  WorktreeAgentGroup,
  WorktreeCodebaseGroup,
  WorktreeDetail,
  WorktreeOverview,
  WorktreeTag,
} from "./types";

const COLORS = [
  "gray",
  "stone",
  "red",
  "rose",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
] as const;
const LAYOUT_KEY = "worktrees-layout";
const PULL_REQUEST_FIELDS =
  "id number title url repositoryGithubId repositoryNameWithOwner repositoryUrl labels jiraKey pipelineStatus pipelines { id name status url checkSuiteId canRetry retryUnavailableReason jobs { id name status url canRetry retryUnavailableReason steps { number name status } } } reviewDecision unresolvedReviewThreadCount createdAt";
const WORKTREE_FIELDS = `
  id codebaseId gitDirectory folder relativePath primary branch headSha upstream ahead behind syncState
  baseBranch baseBranchOverride baseAhead baseBehind hasStagedChanges hasUnstagedChanges highlightColor availability statusError
  ticketKey ticketTitle ticketStatus lastCheckedAt missingAt createdAt updatedAt
  tags { id name color createdAt updatedAt }
  activeJob { id agentId kind payload status idempotencyKey result error timeoutSeconds createdAt startedAt finishedAt updatedAt }
  pullRequest { ${PULL_REQUEST_FIELDS} }
`;
const CODEBASE_FIELDS = `
  id folder observedOrigin branch headSha upstream ahead behind syncState availability statusError
  defaultBranch localBranches remoteBranches lastCheckedAt lastFetchedAt lastFetchAttemptAt lastFetchError createdAt updatedAt
`;
const INSPECT_WORKTREE_MUTATION = `mutation InspectWorktree($id: ID!, $requestId: ID!) {
  inspectWorktree(id: $id, requestId: $requestId) {
    commits { sha subject authorName authoredAt additions deletions }
    changes { path staged unstaged untracked conflicted stagedAdditions stagedDeletions unstagedAdditions unstagedDeletions }
    commitsTruncated changesTruncated
  }
}`;
const LIVE_INSPECTION_RETRY_MS = 1_000;

export function displayedWorktreePath(
  folder: string,
  baseRepoDirectory: string | null | undefined,
): string {
  if (!baseRepoDirectory) return folder;
  const windows =
    /^[A-Za-z]:[\\/]/.test(baseRepoDirectory) ||
    baseRepoDirectory.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  const normalize = (value: string) =>
    windows ? value.replaceAll("/", "\\") : value;
  const trimTrailingSeparators = (value: string) => {
    const root = windows ? /^[A-Za-z]:\\$/.test(value) : value === "/";
    return root ? value : value.replace(/[\\/]+$/, "");
  };
  const base = trimTrailingSeparators(normalize(baseRepoDirectory));
  const worktree = trimTrailingSeparators(normalize(folder));
  const comparableBase = windows ? base.toLocaleLowerCase() : base;
  const comparableWorktree = windows ? worktree.toLocaleLowerCase() : worktree;
  if (comparableWorktree === comparableBase) return ".";
  const prefix = base.endsWith(separator) ? base : `${base}${separator}`;
  const comparablePrefix = windows ? prefix.toLocaleLowerCase() : prefix;
  return comparableWorktree.startsWith(comparablePrefix)
    ? worktree.slice(prefix.length)
    : folder;
}

function replaceIssueParam(issueKey: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (issueKey) params.set("issue", issueKey);
  else params.delete("issue");
  const query = params.toString();
  window.history.pushState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

type Layout = "cards" | "table";
type Operation =
  | "OPEN_EDITOR"
  | "FORCE_PUSH"
  | "SYNC"
  | "PUSH"
  | "RESET"
  | "STASH_ALL"
  | "STAGE_ALL"
  | "UNSTAGE_ALL";

export function worktreeChangeActionState(
  worktree: Pick<Worktree, "hasStagedChanges" | "hasUnstagedChanges">,
) {
  const hasChanges = worktree.hasStagedChanges || worktree.hasUnstagedChanges;
  const allChangesStaged =
    worktree.hasStagedChanges && !worktree.hasUnstagedChanges;
  return {
    hasChanges,
    stageOperation: allChangesStaged
      ? ("UNSTAGE_ALL" as const)
      : ("STAGE_ALL" as const),
  };
}

async function inspectWorktree(worktreeId: string): Promise<WorktreeDetail> {
  const data = await controlPlaneRequest<{
    inspectWorktree: WorktreeDetail;
  }>(INSPECT_WORKTREE_MUTATION, {
    id: worktreeId,
    requestId: createClientId(),
  });
  return data.inspectWorktree;
}

function useQueuedWorktreeInspection(inspect: () => Promise<void>) {
  const running = useRef(false);
  const pending = useRef(false);

  const refresh = useCallback(async () => {
    if (running.current) {
      pending.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        pending.current = false;
        await inspect();
      } while (pending.current);
    } finally {
      running.current = false;
    }
  }, [inspect]);

  return refresh;
}

type WorktreeActivity = {
  worktreeId: string;
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  syncState: Worktree["syncState"] | null;
  baseAhead: number | null;
  baseBehind: number | null;
  hasStagedChanges: boolean | null;
  hasUnstagedChanges: boolean | null;
  observedAt: string;
};

type LiveWorktreeFields = Pick<
  Worktree,
  | "branch"
  | "headSha"
  | "upstream"
  | "ahead"
  | "behind"
  | "syncState"
  | "baseAhead"
  | "baseBehind"
  | "hasStagedChanges"
  | "hasUnstagedChanges"
>;

function useLiveWorktree(source: Worktree) {
  const [override, setOverride] = useState<{
    sourceUpdatedAt: string;
    value: Partial<LiveWorktreeFields>;
  } | null>(null);
  const applyOverride = useCallback(
    (value: Partial<LiveWorktreeFields>) => {
      setOverride((current) => ({
        sourceUpdatedAt: source.updatedAt,
        value:
          current?.sourceUpdatedAt === source.updatedAt
            ? { ...current.value, ...value }
            : value,
      }));
    },
    [source.updatedAt],
  );
  const applyActivity = useCallback(
    (activity: WorktreeActivity) => {
      const value: Partial<LiveWorktreeFields> = {};
      if (activity.hasStagedChanges !== null) {
        value.hasStagedChanges = activity.hasStagedChanges;
      }
      if (activity.hasUnstagedChanges !== null) {
        value.hasUnstagedChanges = activity.hasUnstagedChanges;
      }
      if (typeof activity.headSha === "string") {
        Object.assign(value, {
          branch: activity.branch,
          headSha: activity.headSha,
          upstream: activity.upstream,
          ahead: activity.ahead,
          behind: activity.behind,
          syncState: activity.syncState ?? "UNKNOWN",
          baseAhead: activity.baseAhead,
          baseBehind: activity.baseBehind,
        } satisfies Partial<LiveWorktreeFields>);
      }
      if (Object.keys(value).length) applyOverride(value);
    },
    [applyOverride],
  );
  const setUnstagedChanges = useCallback(
    (value: boolean) => applyOverride({ hasUnstagedChanges: value }),
    [applyOverride],
  );
  return {
    worktree:
      override?.sourceUpdatedAt === source.updatedAt
        ? { ...source, ...override.value }
        : source,
    applyActivity,
    setUnstagedChanges,
  };
}

function useWorktreeActivitySubscription(
  worktreeId: string,
  enabled: boolean,
  onActivity: (activity: WorktreeActivity) => void,
) {
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let generation = 0;
    let retryTimer: number | null = null;
    let unsubscribe: () => void = () => undefined;
    const scheduleRetry = (currentGeneration: number) => {
      if (stopped || currentGeneration !== generation || retryTimer !== null)
        return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        subscribe();
      }, LIVE_INSPECTION_RETRY_MS);
    };
    const subscribe = () => {
      const currentGeneration = ++generation;
      unsubscribe = controlPlaneSubscriptions().subscribe(
        {
          query: `subscription WorktreeInspectionChanged($worktreeId: ID!) {
            worktreeInspectionChanged(worktreeId: $worktreeId) {
              worktreeId branch headSha upstream ahead behind syncState baseAhead baseBehind
              hasStagedChanges hasUnstagedChanges observedAt
            }
          }`,
          variables: { worktreeId },
        },
        {
          next: (result) => {
            const activity = (
              result as {
                data?: { worktreeInspectionChanged?: WorktreeActivity };
              }
            ).data?.worktreeInspectionChanged;
            if (activity) onActivityRef.current(activity);
          },
          error: () => scheduleRetry(currentGeneration),
          complete: () => scheduleRetry(currentGeneration),
        },
      );
    };
    subscribe();
    return () => {
      stopped = true;
      generation += 1;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [enabled, worktreeId]);
}

const highlightColorClasses: Record<string, string> = {
  gray: "border-slate-500/30 bg-slate-500/10",
  stone: "border-stone-500/30 bg-stone-500/10",
  red: "border-red-500/30 bg-red-500/10",
  rose: "border-rose-500/30 bg-rose-500/10",
  orange: "border-orange-500/30 bg-orange-500/10",
  amber: "border-amber-500/30 bg-amber-500/10",
  yellow: "border-yellow-500/30 bg-yellow-500/10",
  lime: "border-lime-500/30 bg-lime-500/10",
  green: "border-green-500/30 bg-green-500/10",
  emerald: "border-emerald-500/30 bg-emerald-500/10",
  teal: "border-teal-500/30 bg-teal-500/10",
  cyan: "border-cyan-500/30 bg-cyan-500/10",
  sky: "border-sky-500/30 bg-sky-500/10",
  blue: "border-blue-500/30 bg-blue-500/10",
  indigo: "border-indigo-500/30 bg-indigo-500/10",
  violet: "border-violet-500/30 bg-violet-500/10",
  purple: "border-purple-500/30 bg-purple-500/10",
  fuchsia: "border-fuchsia-500/30 bg-fuchsia-500/10",
  pink: "border-pink-500/30 bg-pink-500/10",
};

const tagColorClasses: Record<string, string> = {
  gray: "border-slate-500/40 bg-slate-500/15 text-slate-700 dark:text-slate-300",
  stone:
    "border-stone-500/40 bg-stone-500/15 text-stone-700 dark:text-stone-300",
  red: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300",
  rose: "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
  orange:
    "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300",
  amber:
    "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300",
  yellow:
    "border-yellow-500/40 bg-yellow-500/15 text-yellow-800 dark:text-yellow-300",
  lime: "border-lime-500/40 bg-lime-500/15 text-lime-800 dark:text-lime-300",
  green:
    "border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-300",
  emerald:
    "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  teal: "border-teal-500/40 bg-teal-500/15 text-teal-700 dark:text-teal-300",
  cyan: "border-cyan-500/40 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  sky: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  blue: "border-blue-500/40 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  indigo:
    "border-indigo-500/40 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  violet:
    "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  purple:
    "border-purple-500/40 bg-purple-500/15 text-purple-700 dark:text-purple-300",
  fuchsia:
    "border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  pink: "border-pink-500/40 bg-pink-500/15 text-pink-700 dark:text-pink-300",
};

const colorSwatchClasses: Record<string, string> = {
  gray: "border-slate-600 bg-slate-500",
  stone: "border-stone-600 bg-stone-500",
  red: "border-red-600 bg-red-500",
  rose: "border-rose-600 bg-rose-500",
  orange: "border-orange-600 bg-orange-500",
  amber: "border-amber-600 bg-amber-500",
  yellow: "border-yellow-600 bg-yellow-500",
  lime: "border-lime-600 bg-lime-500",
  green: "border-green-600 bg-green-500",
  emerald: "border-emerald-600 bg-emerald-500",
  teal: "border-teal-600 bg-teal-500",
  cyan: "border-cyan-600 bg-cyan-500",
  sky: "border-sky-600 bg-sky-500",
  blue: "border-blue-600 bg-blue-500",
  indigo: "border-indigo-600 bg-indigo-500",
  violet: "border-violet-600 bg-violet-500",
  purple: "border-purple-600 bg-purple-500",
  fuchsia: "border-fuchsia-600 bg-fuchsia-500",
  pink: "border-pink-600 bg-pink-500",
};

function reviewClass(value: string) {
  if (value === "APPROVED")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "CHANGES_REQUESTED")
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

export function WorktreesPage() {
  const t = useTranslations("worktrees");
  const [jiraIssueKey, setJiraIssueKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("issue");
  });
  const [overview, setOverview] = useState<WorktreeOverview | null>(null);
  const [layout, setLayout] = useState<Layout>(() => {
    if (typeof window === "undefined") return "cards";
    const saved = window.localStorage.getItem(LAYOUT_KEY);
    return saved === "table" ? "table" : "cards";
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inspectionRefreshToken, setInspectionRefreshToken] = useState(0);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const data = await controlPlaneRequest<{
        worktreeOverview: WorktreeOverview;
      }>(
        `query WorktreeOverview {
          worktreeOverview {
            hiddenCount
            settings { editorVariant updatedAt }
            tags { id name color createdAt updatedAt }
            agents {
              agent { ${AGENT_FIELDS} }
              codebases {
                repository { id canonicalOrigin displayOrigin name description jiraBranchRegex keepBaseBranchUpToDate createdAt updatedAt }
                codebase { ${CODEBASE_FIELDS} }
                worktrees { ${WORKTREE_FIELDS} }
              }
            }
          }
        }`,
      );
      if (request !== latestLoad.current) return;
      setOverview(data.worktreeOverview);
      setError(null);
    } catch (value) {
      if (request === latestLoad.current)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (request === latestLoad.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => void load(), 30_000);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      {
        query:
          "subscription WorktreesChanged { worktreeOverviewChanged { worktreeId codebaseId } }",
      },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
      latestLoad.current += 1;
      unsubscribe();
    };
  }, [load]);

  useEffect(() => {
    const syncIssueFromUrl = () =>
      setJiraIssueKey(new URLSearchParams(window.location.search).get("issue"));
    window.addEventListener("popstate", syncIssueFromUrl);
    return () => window.removeEventListener("popstate", syncIssueFromUrl);
  }, []);

  const selectJiraIssue = (issueKey: string | null) => {
    replaceIssueParam(issueKey);
    setJiraIssueKey(issueKey);
  };

  const setLayoutAndRemember = (next: Layout) => {
    setLayout(next);
    window.localStorage.setItem(LAYOUT_KEY, next);
  };

  const refresh = async () => {
    setLoading(true);
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation RefreshWorktrees {
          refreshWorktrees
        }`,
      );
      await load();
      setInspectionRefreshToken((value) => value + 1);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  const fetchNow = async () => {
    const ids =
      overview?.agents.flatMap((agent) =>
        agent.codebases.map((group) => group.codebase.id),
      ) ?? [];
    if (!ids.length) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation FetchWorktreeCodebases($input: RunCodebaseOperationInput!) {
          fetchCodebases(input: $input) { jobs { id } skipped { codebaseId reason } }
        }`,
        { input: { codebaseIds: ids, requestId: createClientId() } },
      );
      setNotice(t("fetchStarted"));
      setError(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const updateLocalWorktree = (next: Worktree) => {
    setOverview((current) =>
      current
        ? {
            ...current,
            agents: current.agents.map((agent) => ({
              ...agent,
              codebases: agent.codebases.map((group) => ({
                ...group,
                worktrees: group.worktrees.map((worktree) =>
                  worktree.id === next.id
                    ? {
                        ...worktree,
                        ...next,
                        ticketKey: next.ticketKey ?? worktree.ticketKey,
                        ticketTitle: next.ticketTitle ?? worktree.ticketTitle,
                        ticketStatus:
                          next.ticketStatus ?? worktree.ticketStatus,
                        pullRequest: next.pullRequest ?? worktree.pullRequest,
                      }
                    : worktree,
                ),
              })),
            })),
          }
        : current,
    );
  };

  return (
    <section className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => void refresh()}
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />{" "}
            {t("refresh")}
          </Button>
          <Button
            disabled={busy || !overview?.agents.length}
            onClick={() => void fetchNow()}
            variant="outline"
          >
            <Upload /> {t("fetchNow")}
          </Button>
          <Button onClick={() => setHiddenOpen(true)} variant="outline">
            <Archive /> {t("hidden", { count: overview?.hiddenCount ?? 0 })}
          </Button>
          <div className="flex rounded-lg border p-0.5">
            <Button
              aria-label={t("cards")}
              onClick={() => setLayoutAndRemember("cards")}
              size="icon-sm"
              variant={layout === "cards" ? "secondary" : "ghost"}
            >
              <Grid2X2 />
            </Button>
            <Button
              aria-label={t("table")}
              onClick={() => setLayoutAndRemember("table")}
              size="icon-sm"
              variant={layout === "table" ? "secondary" : "ghost"}
            >
              <List />
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {overview && (
        <CreateWorktreeCard
          onCreated={async () => {
            await load();
            setNotice(t("worktreeCreated"));
          }}
          overview={overview}
        />
      )}

      {loading && !overview ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : !overview?.agents.length ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranch />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        overview.agents.map((agentGroup) => (
          <AgentSection
            agentGroup={agentGroup}
            allTags={overview.tags}
            editorVariant={overview.settings.editorVariant}
            inspectionRefreshToken={inspectionRefreshToken}
            key={agentGroup.agent.id}
            layout={layout}
            onError={setError}
            onManageTags={() => setTagManagerOpen(true)}
            onOpenTicket={(issueKey) => selectJiraIssue(issueKey)}
            onReload={load}
            onUpdate={updateLocalWorktree}
          />
        ))
      )}

      <TagManagerDialog
        onChanged={load}
        onOpenChange={setTagManagerOpen}
        open={tagManagerOpen}
        tags={overview?.tags ?? []}
      />
      <HiddenWorktreesDialog
        onChanged={load}
        onOpenChange={setHiddenOpen}
        open={hiddenOpen}
      />
      <JiraTicketDrawer
        issueKey={jiraIssueKey}
        onClose={() => selectJiraIssue(null)}
      />
    </section>
  );
}

function branchTarget(
  group: WorktreeCodebaseGroup,
  worktree?: Worktree,
): WorktreeBranchTarget {
  return {
    codebaseId: group.codebase.id,
    ...(worktree ? { worktreeId: worktree.id } : {}),
    defaultBranch: group.codebase.defaultBranch,
    currentBranch: worktree?.branch,
    currentBaseBranch: worktree?.baseBranch,
    localBranches: group.codebase.localBranches,
    remoteBranches: group.codebase.remoteBranches,
    unavailableBranches: group.worktrees.flatMap((candidate) =>
      candidate.branch && candidate.id !== worktree?.id
        ? [candidate.branch]
        : [],
    ),
  };
}

function CreateWorktreeCard({
  overview,
  onCreated,
}: {
  overview: WorktreeOverview;
  onCreated: () => Promise<void>;
}) {
  const t = useTranslations("worktrees");
  const eligible = overview.agents.flatMap((agentGroup) =>
    agentGroup.codebases.flatMap((group) =>
      agentGroup.agent.connectionStatus === "ONLINE" &&
      agentGroup.agent.capabilities.includes("worktree.branch") &&
      group.codebase.availability === "AVAILABLE" &&
      !group.worktrees.some((worktree) => worktree.activeJob)
        ? [{ agentGroup, group }]
        : [],
    ),
  );
  const [codebaseId, setCodebaseId] = useState(
    eligible.length === 1 ? eligible[0]!.group.codebase.id : "",
  );
  const [busy, setBusy] = useState(false);
  const effectiveCodebaseId = eligible.some(
    (entry) => entry.group.codebase.id === codebaseId,
  )
    ? codebaseId
    : eligible.length === 1
      ? eligible[0]!.group.codebase.id
      : "";
  const selected = eligible.find(
    (entry) => entry.group.codebase.id === effectiveCodebaseId,
  );
  const options: SearchableSelectOption[] = eligible.map(
    ({ agentGroup, group }) => ({
      value: group.codebase.id,
      label: `${group.repository.name} · ${agentGroup.agent.name}`,
      description: group.codebase.folder,
      keywords: `${group.repository.displayOrigin} ${agentGroup.agent.hostname}`,
    }),
  );
  const create = async (selection: WorktreeBranchSelection) => {
    if (!selected) throw new Error(t("selectCodebase"));
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        createWorktree: { id: string };
      }>(
        `mutation CreateWorktree($input: CreateWorktreeInput!) {
          createWorktree(input: $input) { id }
        }`,
        {
          input: {
            codebaseId: selected.group.codebase.id,
            selection,
            requestId: createClientId(),
          },
        },
      );
      await waitForWorktreeJob(data.createWorktree.id);
      await onCreated();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Plus /> {t("createWorktree")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="mb-1.5 block">{t("repositoryCheckout")}</Label>
          <SearchableSelect
            ariaLabel={t("repositoryCheckout")}
            disabled={busy || options.length === 0}
            emptyMessage={t("noEligibleCodebases")}
            onValueChange={setCodebaseId}
            options={options}
            placeholder={t("selectCodebase")}
            searchPlaceholder={t("searchCodebases")}
            value={effectiveCodebaseId}
          />
        </div>
        {selected ? (
          <WorktreeBranchForm
            busy={busy}
            key={selected.group.codebase.id}
            onSubmit={create}
            submitLabel={t("createWorktree")}
            target={branchTarget(selected.group)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {options.length
              ? t("selectCodebaseHelp")
              : t("noEligibleCodebases")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AgentSection({
  agentGroup,
  layout,
  allTags,
  editorVariant,
  inspectionRefreshToken,
  onReload,
  onUpdate,
  onError,
  onManageTags,
  onOpenTicket,
}: {
  agentGroup: WorktreeAgentGroup;
  layout: Layout;
  allTags: WorktreeTag[];
  editorVariant: WorktreeOverview["settings"]["editorVariant"];
  inspectionRefreshToken: number;
  onReload: () => Promise<void>;
  onUpdate: (worktree: Worktree) => void;
  onError: (error: string | null) => void;
  onManageTags: () => void;
  onOpenTicket: (issueKey: string) => void;
}) {
  const t = useTranslations("worktrees");
  const liveUpdatesEnabled =
    agentGroup.agent.connectionStatus === "ONLINE" &&
    agentGroup.agent.capabilities.includes("worktree.watch");
  const branchManagementEnabled =
    agentGroup.agent.connectionStatus === "ONLINE" &&
    agentGroup.agent.capabilities.includes("worktree.branch");
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 border-b pb-2">
        <h2 className="text-lg font-semibold">{agentGroup.agent.name}</h2>
        <Badge>
          {agentGroup.agent.connectionStatus === "ONLINE"
            ? t("online")
            : t("offline")}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {agentGroup.agent.hostname}
        </span>
      </div>
      {agentGroup.codebases.map((group) => (
        <section className="space-y-3" key={group.codebase.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">{group.repository.name}</h3>
              <p className="font-mono text-xs text-muted-foreground">
                {group.repository.displayOrigin}
              </p>
            </div>
            <FetchAge codebase={group.codebase} />
          </div>
          {layout === "cards" ? (
            <div className="space-y-3">
              {group.worktrees.map((worktree) => (
                <WorktreeCard
                  allTags={allTags}
                  baseRepoDirectory={agentGroup.agent.baseRepoDirectory}
                  branchManagementEnabled={branchManagementEnabled}
                  editorVariant={editorVariant}
                  group={group}
                  inspectionRefreshToken={inspectionRefreshToken}
                  key={worktree.id}
                  liveUpdatesEnabled={liveUpdatesEnabled}
                  onError={onError}
                  onManageTags={onManageTags}
                  onOpenTicket={onOpenTicket}
                  onReload={onReload}
                  onUpdate={onUpdate}
                  worktree={worktree}
                />
              ))}
            </div>
          ) : (
            <WorktreeTable
              allTags={allTags}
              baseRepoDirectory={agentGroup.agent.baseRepoDirectory}
              branchManagementEnabled={branchManagementEnabled}
              editorVariant={editorVariant}
              group={group}
              inspectionRefreshToken={inspectionRefreshToken}
              liveUpdatesEnabled={liveUpdatesEnabled}
              onError={onError}
              onManageTags={onManageTags}
              onOpenTicket={onOpenTicket}
              onReload={onReload}
              onUpdate={onUpdate}
            />
          )}
        </section>
      ))}
    </section>
  );
}

function FetchAge({
  codebase,
}: {
  codebase: WorktreeCodebaseGroup["codebase"];
}) {
  const t = useTranslations("worktrees");
  const locale = useLocale();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date().getTime());
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);
  const age =
    codebase.lastFetchedAt && now !== null
      ? Math.max(0, now - new Date(codebase.lastFetchedAt).getTime())
      : null;
  const value =
    age === null
      ? t("neverFetched")
      : age < 60_000
        ? t("secondsAgo", { count: Math.floor(age / 1_000) })
        : new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
            -Math.floor(age / 60_000),
            "minute",
          );
  return (
    <span
      className={cn(
        "text-xs text-muted-foreground",
        codebase.lastFetchError && "text-destructive",
      )}
      title={codebase.lastFetchError ?? undefined}
    >
      {t("lastFetched", { value })}
    </span>
  );
}

function WorktreeCard(props: WorktreeItemProps) {
  const { inspectionRefreshToken, onError } = props;
  const { worktree, applyActivity, setUnstagedChanges } = useLiveWorktree(
    props.worktree,
  );
  const liveProps = { ...props, worktree };
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<WorktreeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);
  const lastInspectionRefreshToken = useRef(inspectionRefreshToken);
  const t = useTranslations("worktrees");
  const inspect = useCallback(async () => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    try {
      const next = await inspectWorktree(worktree.id);
      if (request !== detailRequest.current) return;
      setDetail(next);
      setUnstagedChanges(
        next.changes.some(
          (change) => change.unstaged || change.untracked || change.conflicted,
        ),
      );
      onError(null);
    } catch (value) {
      if (request === detailRequest.current)
        onError(value instanceof Error ? value.message : String(value));
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, [onError, setUnstagedChanges, worktree.id]);
  const refreshInspection = useQueuedWorktreeInspection(inspect);
  const handleActivity = useCallback(
    (activity: WorktreeActivity) => {
      applyActivity(activity);
      if (expanded) void refreshInspection();
    },
    [applyActivity, expanded, refreshInspection],
  );
  useWorktreeActivitySubscription(
    worktree.id,
    props.liveUpdatesEnabled && worktree.availability === "AVAILABLE",
    handleActivity,
  );
  useEffect(() => {
    if (lastInspectionRefreshToken.current === inspectionRefreshToken) return;
    lastInspectionRefreshToken.current = inspectionRefreshToken;
    if (!expanded) return;
    const timer = window.setTimeout(() => void refreshInspection(), 0);
    return () => window.clearTimeout(timer);
  }, [expanded, inspectionRefreshToken, refreshInspection]);
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || detail) return;
    void refreshInspection();
  };
  return (
    <Card
      className={cn(
        worktree.highlightColor &&
          highlightColorClasses[worktree.highlightColor],
      )}
    >
      <CardHeader className="border-b">
        <CardTitle>
          <Button
            className="h-auto max-w-full justify-start gap-1 p-1 text-left"
            onClick={() => void toggle()}
            variant="ghost"
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            <span className="truncate font-mono">
              {worktree.branch ??
                worktree.headSha?.slice(0, 10) ??
                t("detached")}
            </span>
          </Button>
          {(worktree.ticketKey || worktree.ticketTitle) && (
            <WorktreeTicketLink {...liveProps} />
          )}
        </CardTitle>
        <CardAction className="flex max-w-full flex-wrap items-center justify-end gap-1">
          <OriginStatusBadges worktree={worktree} />
          {worktree.hasUnstagedChanges && (
            <Badge variant="destructive">{t("dirty")}</Badge>
          )}
          <WorktreeMenus {...liveProps} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <WorktreeMetadata
          {...liveProps}
          detailsExpanded={expanded}
          onToggleDetails={toggle}
        />
        {detailLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("loadingDetails")}
          </p>
        )}
        {expanded && detail && <DetailPanel detail={detail} />}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <ActionRow
          {...liveProps}
          onCompleted={async () => {
            await props.onReload();
            if (expanded) await refreshInspection();
          }}
        />
      </CardFooter>
    </Card>
  );
}

type WorktreeItemProps = {
  worktree: Worktree;
  group: WorktreeCodebaseGroup;
  allTags: WorktreeTag[];
  baseRepoDirectory: string | null;
  branchManagementEnabled: boolean;
  editorVariant: WorktreeOverview["settings"]["editorVariant"];
  inspectionRefreshToken: number;
  liveUpdatesEnabled: boolean;
  onReload: () => Promise<void>;
  onUpdate: (worktree: Worktree) => void;
  onError: (error: string | null) => void;
  onManageTags: () => void;
  onOpenTicket: (issueKey: string) => void;
};

function WorktreeTicketLink({
  worktree,
  onOpenTicket,
  compact = false,
}: Pick<WorktreeItemProps, "worktree" | "onOpenTicket"> & {
  compact?: boolean;
}) {
  const label = `${worktree.ticketKey ?? ""}${
    worktree.ticketTitle
      ? `${worktree.ticketKey ? " — " : ""}${worktree.ticketTitle}`
      : ""
  }`;
  return (
    <div
      className={cn(
        "flex max-w-full items-center gap-1.5 font-normal",
        compact ? "mt-0.5 text-xs" : "mt-1 text-sm",
      )}
    >
      {!worktree.ticketKey ? (
        <p className="min-w-0 truncate text-muted-foreground" title={label}>
          {label}
        </p>
      ) : (
        <button
          className="min-w-0 truncate text-left text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpenTicket(worktree.ticketKey!)}
          title={label}
          type="button"
        >
          {label}
        </button>
      )}
      {worktree.ticketStatus && (
        <Badge variant="secondary">{worktree.ticketStatus}</Badge>
      )}
    </div>
  );
}

function WorktreeMetadata(
  props: WorktreeItemProps & {
    detailsExpanded?: boolean;
    onToggleDetails?: () => void;
  },
) {
  const {
    worktree,
    group,
    baseRepoDirectory,
    detailsExpanded,
    onToggleDetails,
  } = props;
  const t = useTranslations("worktrees");
  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <Info
          label={t("path")}
          mono
          value={displayedWorktreePath(worktree.folder, baseRepoDirectory)}
        />
        <BaseBranchControl {...props} />
      </div>
      <MetadataRow label={t("upToDate")}>
        <BaseFreshnessBadge worktree={worktree} />
      </MetadataRow>
      <WorktreeTagsMenu {...props} />
      <MetadataRow label={t("pullRequest")}>
        <PullRequestBadges
          detailsExpanded={detailsExpanded}
          onToggleDetails={onToggleDetails}
          worktree={worktree}
        />
      </MetadataRow>
      <div className="flex flex-wrap items-center gap-2">
        {worktree.statusError && (
          <span className="text-xs text-destructive">
            {worktree.statusError}
          </span>
        )}
        {!group.codebase.defaultBranch && !worktree.baseBranchOverride && (
          <span className="text-xs text-destructive">
            {t("baseUnavailable")}
          </span>
        )}
      </div>
    </div>
  );
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="w-24 shrink-0 text-xs text-muted-foreground">{label}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}

function WorktreeTagsMenu({
  compact = false,
  ...props
}: WorktreeItemProps & { compact?: boolean }) {
  const { worktree } = props;
  const t = useTranslations("worktrees");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!compact && (
        <span className="w-24 shrink-0 text-xs text-muted-foreground">
          {t("tags")}
        </span>
      )}
      <WorktreeMenus
        {...props}
        contentAlign={compact ? "end" : "start"}
        contentAlignOffset={compact ? 0 : -100}
        trigger={
          <button
            aria-label={`${t("tags")}: ${worktree.branch ?? t("detached")}`}
            className={cn(
              "flex min-h-7 max-w-full items-center rounded-md px-1 py-1 text-left hover:bg-muted focus-visible:outline-none",
              !compact && "-mx-1",
            )}
            type="button"
          >
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {worktree.tags.map((tag) => (
                <TagBadge key={tag.id} tag={tag} />
              ))}
              {!worktree.tags.length && (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
          </button>
        }
      />
    </div>
  );
}

function BaseFreshnessBadge({ worktree }: { worktree: Worktree }) {
  const t = useTranslations("worktrees");
  const current = worktree.baseBehind === 0;
  return (
    <Badge
      className={
        current
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : worktree.baseBehind === null
            ? undefined
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      }
      variant="outline"
    >
      {worktree.baseBehind === null
        ? t("unknown")
        : current
          ? t("yes")
          : t("notUpToDate", { count: worktree.baseBehind })}
    </Badge>
  );
}

function PullRequestBadges({
  worktree,
  detailsExpanded,
  onToggleDetails,
}: {
  worktree: Worktree;
  detailsExpanded?: boolean;
  onToggleDetails?: () => void;
}) {
  const t = useTranslations("worktrees");
  return (
    <>
      {worktree.pullRequest ? (
        <>
          <PullRequestMenu pullRequest={worktree.pullRequest} />
          <PipelineMenu
            pipelineStatus={worktree.pullRequest.pipelineStatus}
            pipelines={worktree.pullRequest.pipelines}
            repositoryId={worktree.pullRequest.repositoryGithubId}
          />
          <Badge className={reviewClass(worktree.pullRequest.reviewDecision)}>
            {t(`review.${worktree.pullRequest.reviewDecision}`)}
          </Badge>
        </>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
      {onToggleDetails ? (
        <Badge asChild variant="secondary">
          <button
            aria-expanded={detailsExpanded}
            onClick={onToggleDetails}
            type="button"
          >
            {t("branchCommits", { count: worktree.baseAhead ?? 0 })}
          </button>
        </Badge>
      ) : (
        <Badge variant="secondary">
          {t("branchCommits", { count: worktree.baseAhead ?? 0 })}
        </Badge>
      )}
    </>
  );
}

function PullRequestMenu({
  pullRequest,
}: {
  pullRequest: NonNullable<Worktree["pullRequest"]>;
}) {
  const t = useTranslations("worktrees");
  const [owner, repository] = pullRequest.repositoryNameWithOwner.split("/");
  const detailsHref = `/pull-requests/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repository ?? "")}/${pullRequest.number}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge asChild>
          <button type="button">PR #{pullRequest.number}</button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem asChild>
          <a href={pullRequest.url} rel="noreferrer" target="_blank">
            <ExternalLink />
            {t("openInGitHub")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={detailsHref}>
            <GitPullRequest />
            {t("openDetails")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OriginStatusBadges({ worktree }: { worktree: Worktree }) {
  const t = useTranslations("worktrees");
  if (
    worktree.syncState === "IN_SYNC" ||
    (worktree.ahead === 0 && worktree.behind === 0)
  ) {
    return (
      <Badge
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        variant="outline"
      >
        {t("inSync")}
      </Badge>
    );
  }
  if (worktree.ahead !== null || worktree.behind !== null) {
    return (
      <>
        {worktree.ahead !== null && (
          <Badge
            className="border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
            variant="outline"
          >
            <ArrowUp data-icon="inline-start" />
            {t("ahead", { count: worktree.ahead })}
          </Badge>
        )}
        {worktree.behind !== null && (
          <Badge
            className="border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
            variant="outline"
          >
            <ArrowDown data-icon="inline-start" />
            {t("behind", { count: worktree.behind })}
          </Badge>
        )}
      </>
    );
  }
  return <Badge variant="outline">{syncText(worktree, t)}</Badge>;
}

function syncText(
  worktree: Worktree,
  t: ReturnType<typeof useTranslations<"worktrees">>,
) {
  if (worktree.syncState === "AHEAD")
    return t("ahead", { count: worktree.ahead ?? 0 });
  if (worktree.syncState === "BEHIND")
    return t("behind", { count: worktree.behind ?? 0 });
  if (worktree.syncState === "DIVERGED") return t("diverged");
  if (worktree.syncState === "IN_SYNC") return t("upToDate");
  if (worktree.syncState === "NO_UPSTREAM") return t("unpublished");
  if (worktree.syncState === "DETACHED") return t("detached");
  return t("unknown");
}

function BaseBranchControl(props: WorktreeItemProps & { compact?: boolean }) {
  const { worktree, group, onUpdate, onError, compact = false } = props;
  const t = useTranslations("worktrees");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const inheritValue = "__inherit_remote_default__";
  const branches = Array.from(
    new Set(
      [
        worktree.baseBranchOverride,
        group.codebase.defaultBranch,
        ...group.codebase.remoteBranches,
      ].filter((branch): branch is string => Boolean(branch)),
    ),
  );
  const save = async (next: string) => {
    setSaving(true);
    try {
      const data = await controlPlaneRequest<{
        updateWorktreeBaseBranch: Worktree;
      }>(
        `mutation UpdateWorktreeBase($id: ID!, $baseBranch: String) {
          updateWorktreeBaseBranch(id: $id, baseBranch: $baseBranch) { ${WORKTREE_FIELDS} }
        }`,
        { id: worktree.id, baseBranch: next || null },
      );
      onUpdate(data.updateWorktreeBaseBranch);
      onError(null);
      setEditing(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="min-w-0">
      {!compact && (
        <p className="text-xs text-muted-foreground">{t("baseBranch")}</p>
      )}
      <div
        className={cn(
          "flex min-h-6 min-w-0 items-center gap-1",
          !compact && "mt-0.5",
        )}
      >
        {editing ? (
          <Select
            disabled={saving}
            onOpenChange={setEditing}
            onValueChange={(next) =>
              void save(next === inheritValue ? "" : next)
            }
            open={editing}
            value={
              worktree.baseBranchOverride ??
              (group.codebase.defaultBranch ? inheritValue : undefined)
            }
          >
            <SelectTrigger
              aria-label={t("baseBranch")}
              className="h-7 min-w-40 max-w-full font-mono text-xs"
              size="sm"
            >
              <SelectValue placeholder={t("baseUnavailable")} />
            </SelectTrigger>
            <SelectContent align="start">
              {group.codebase.defaultBranch && (
                <SelectItem value={inheritValue}>
                  {group.codebase.defaultBranch} · {t("inheritBase")}
                </SelectItem>
              )}
              {branches.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <>
            <span
              className="truncate font-mono text-xs"
              title={worktree.baseBranch ?? undefined}
            >
              {worktree.baseBranch ?? "—"}
            </span>
            <Button
              aria-label={t("editBase")}
              onClick={() => setEditing(true)}
              size="icon-xs"
              variant="ghost"
            >
              <Pencil />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function WorktreeMenus(
  props: WorktreeItemProps & {
    contentAlign?: "start" | "end";
    contentAlignOffset?: number;
    trigger?: React.ReactElement;
  },
) {
  const {
    worktree,
    allTags,
    onUpdate,
    onError,
    onManageTags,
    contentAlign = "end",
    contentAlignOffset = 0,
    trigger,
  } = props;
  const t = useTranslations("worktrees");
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeBusy, setChangeBusy] = useState(false);
  const [failedSelection, setFailedSelection] =
    useState<WorktreeBranchSelection | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const openChangeBranchOnMenuClose = useRef(false);
  const assigned = new Set(worktree.tags.map((tag) => tag.id));
  const assign = async (tagId: string, checked: boolean) => {
    const tagIds = checked
      ? [...assigned, tagId]
      : [...assigned].filter((id) => id !== tagId);
    try {
      const data = await controlPlaneRequest<{ setWorktreeTags: Worktree }>(
        `mutation SetWorktreeTags($id: ID!, $tagIds: [ID!]!) { setWorktreeTags(id: $id, tagIds: $tagIds) { ${WORKTREE_FIELDS} } }`,
        { id: worktree.id, tagIds },
      );
      onUpdate(data.setWorktreeTags);
      onError(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };
  const highlight = async (color: string | null) => {
    try {
      const data = await controlPlaneRequest<{
        updateWorktreeHighlight: Worktree;
      }>(
        `mutation HighlightWorktree($id: ID!, $color: String) { updateWorktreeHighlight(id: $id, color: $color) { ${WORKTREE_FIELDS} } }`,
        { id: worktree.id, color },
      );
      onUpdate(data.updateWorktreeHighlight);
      onError(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };
  const changeBranch = async (
    selection: WorktreeBranchSelection,
    stashOnFailure = false,
  ) => {
    setChangeBusy(true);
    try {
      const data = await controlPlaneRequest<{
        changeWorktreeBranch: { id: string };
      }>(
        `mutation ChangeWorktreeBranch($input: ChangeWorktreeBranchInput!) {
          changeWorktreeBranch(input: $input) { id }
        }`,
        {
          input: {
            worktreeId: worktree.id,
            selection,
            requestId: createClientId(),
            stashOnFailure,
          },
        },
      );
      await waitForWorktreeJob(data.changeWorktreeBranch.id);
      await props.onReload();
      setFailedSelection(null);
      setRetryError(null);
      setChangeOpen(false);
      onError(null);
    } finally {
      setChangeBusy(false);
    }
  };
  const recover = async () => {
    if (!failedSelection) return;
    try {
      setRetryError(null);
      await changeBranch(failedSelection, true);
    } catch (value) {
      setRetryError(value instanceof Error ? value.message : String(value));
    }
  };
  return (
    <Popover
      onOpenChange={(open) => {
        setChangeOpen(open);
        if (!open) {
          setFailedSelection(null);
          setRetryError(null);
        }
      }}
      open={changeOpen}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <PopoverAnchor asChild>
            {trigger ?? (
              <Button
                aria-label={t("customize")}
                size="icon-sm"
                variant="ghost"
              >
                <MoreHorizontal />
              </Button>
            )}
          </PopoverAnchor>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={contentAlign}
          alignOffset={contentAlignOffset}
          className="w-72"
          onCloseAutoFocus={(event) => {
            if (!openChangeBranchOnMenuClose.current) return;
            openChangeBranchOnMenuClose.current = false;
            event.preventDefault();
            setChangeOpen(true);
          }}
        >
          <DropdownMenuItem
            disabled={
              !props.branchManagementEnabled ||
              worktree.availability !== "AVAILABLE" ||
              Boolean(worktree.activeJob)
            }
            onSelect={() => {
              openChangeBranchOnMenuClose.current = true;
            }}
          >
            <GitBranch /> {t("changeBranch")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-1.5 leading-none">
            <Tags className="size-3" />
            <span>{t("tags")}</span>
          </DropdownMenuLabel>
          {allTags.map((tag) => (
            <DropdownMenuCheckboxItem
              checked={assigned.has(tag.id)}
              key={tag.id}
              onCheckedChange={(checked) =>
                void assign(tag.id, Boolean(checked))
              }
            >
              <span
                className={cn(
                  "size-3 rounded-full border",
                  colorSwatchClasses[tag.color],
                )}
              />{" "}
              {tag.name}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuItem onSelect={onManageTags}>
            <Plus /> {t("manageTags")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-1.5 leading-none">
            <Paintbrush className="size-3" />
            <span>{t("highlight")}</span>
          </DropdownMenuLabel>
          <div
            className="grid grid-cols-7 gap-1 p-2"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              aria-label={t("clearHighlight")}
              className="flex size-7 items-center justify-center rounded border"
              onClick={() => void highlight(null)}
              type="button"
            >
              <Trash2 className="size-3" />
            </button>
            {COLORS.map((color) => (
              <button
                aria-label={color}
                className={cn(
                  "size-7 rounded border",
                  colorSwatchClasses[color],
                  worktree.highlightColor === color && "ring-2 ring-foreground",
                )}
                key={color}
                onClick={() => void highlight(color)}
                type="button"
              />
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent
        align={contentAlign}
        className="z-60 w-[min(28rem,calc(100vw-2rem))]"
      >
        <div className="mb-4">
          <h3 className="font-semibold">{t("changeBranch")}</h3>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {displayedWorktreePath(worktree.folder, props.baseRepoDirectory)}
          </p>
        </div>
        <WorktreeBranchForm
          busy={changeBusy}
          onSubmit={(selection) => changeBranch(selection)}
          onSubmitError={(selection) => {
            setFailedSelection(
              worktree.hasStagedChanges || worktree.hasUnstagedChanges
                ? selection
                : null,
            );
          }}
          recovery={
            failedSelection ? (
              <Alert>
                <AlertDescription className="space-y-2">
                  <p>{t("stashRetryHelp")}</p>
                  {retryError && (
                    <p className="text-destructive">{retryError}</p>
                  )}
                  <Button
                    disabled={changeBusy}
                    onClick={() => void recover()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {changeBusy && <Spinner />}
                    {t("stashAndRetry")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null
          }
          submitLabel={t("changeBranch")}
          target={branchTarget(props.group, worktree)}
        />
      </PopoverContent>
    </Popover>
  );
}

function ActionRow(
  props: WorktreeItemProps & { onCompleted: () => Promise<void> },
) {
  const { worktree, editorVariant } = props;
  const t = useTranslations("worktrees");
  const unavailable =
    worktree.availability !== "AVAILABLE" || Boolean(worktree.activeJob);
  const changeActions = worktreeChangeActionState(worktree);
  return (
    <div className="flex flex-wrap gap-2">
      {editorVariant !== "NONE" && (
        <OperationButton
          icon={<Code2 />}
          label={
            editorVariant === "CODE_INSIDERS"
              ? t("openInsiders")
              : t("openCode")
          }
          operation="OPEN_EDITOR"
          props={props}
        />
      )}
      <OperationButton
        confirm
        icon={<Upload />}
        label={t("forcePush")}
        operation="FORCE_PUSH"
        props={props}
        disabled={unavailable || !worktree.upstream}
      />
      <OperationButton
        confirm
        icon={<RefreshCw />}
        label={t("sync")}
        operation="SYNC"
        props={props}
        disabled={
          unavailable ||
          !worktree.upstream ||
          !worktree.baseBranch ||
          worktree.baseBehind === 0
        }
      />
      <OperationButton
        icon={<Upload />}
        label={worktree.upstream ? t("push") : t("publish")}
        operation="PUSH"
        props={props}
        disabled={unavailable || !worktree.branch}
      />
      <OperationButton
        confirm
        icon={<RotateCcw />}
        label={t("reset")}
        operation="RESET"
        props={props}
        disabled={unavailable || !worktree.upstream}
      />
      <OperationButton
        icon={<Archive />}
        label={t("stashAll")}
        operation="STASH_ALL"
        props={props}
        disabled={unavailable || !changeActions.hasChanges}
      />
      <OperationButton
        icon={<Check />}
        label={
          changeActions.stageOperation === "UNSTAGE_ALL"
            ? t("unstageAll")
            : t("stageAll")
        }
        operation={changeActions.stageOperation}
        props={props}
        disabled={unavailable || !changeActions.hasChanges}
      />
      {worktree.activeJob && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Spinner /> {t("operationRunning")}
        </span>
      )}
    </div>
  );
}

function OperationButton({
  props,
  operation,
  label,
  icon,
  confirm = false,
  disabled = false,
}: {
  props: WorktreeItemProps & { onCompleted: () => Promise<void> };
  operation: Operation;
  label: string;
  icon: React.ReactNode;
  confirm?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("worktrees");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const run = async () => {
    if (confirm && !armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 5_000);
      return;
    }
    setBusy(true);
    setArmed(false);
    try {
      const data = await controlPlaneRequest<{
        runWorktreeOperation: { id: string };
      }>(
        `mutation RunWorktreeOperation($input: RunWorktreeOperationInput!) { runWorktreeOperation(input: $input) { id } }`,
        {
          input: {
            worktreeId: props.worktree.id,
            operation,
            requestId: createClientId(),
          },
        },
      );
      props.onError(null);
      await props.onCompleted();
      await waitForWorktreeJob(data.runWorktreeOperation.id);
      await props.onCompleted();
    } catch (value) {
      props.onError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      disabled={disabled || busy}
      onClick={() => void run()}
      size="sm"
      variant={armed ? "destructive" : "outline"}
    >
      {busy ? <Spinner /> : armed ? <Check /> : icon}{" "}
      {armed ? t("confirmAction") : label}
    </Button>
  );
}

function DetailPanel({ detail }: { detail: WorktreeDetail }) {
  const t = useTranslations("worktrees");
  const locale = useLocale();
  return (
    <div
      className="w-full space-y-4 border-t pt-4"
      data-testid="worktree-detail"
    >
      <section className="w-full">
        <h4 className="mb-2 font-medium">
          {t("changes", { count: detail.changes.length })}
        </h4>
        <div className="max-h-80 overflow-auto rounded-md border">
          {detail.changes.length ? (
            <Table
              aria-label={t("changes", { count: detail.changes.length })}
              className="table-fixed text-xs"
            >
              <TableBody>
                {detail.changes.map((change) => (
                  <TableRow key={change.path}>
                    <TableCell className="max-w-0 px-2 py-1.5 font-mono">
                      <span className="block truncate" title={change.path}>
                        {change.path}
                      </span>
                    </TableCell>
                    <TableCell className="w-px px-2 py-1.5">
                      <div className="flex items-center justify-end gap-2">
                        {change.conflicted && (
                          <Badge className="px-1.5" variant="destructive">
                            {t("conflicted")}
                          </Badge>
                        )}
                        {change.staged && (
                          <ChangeState
                            additions={change.stagedAdditions}
                            deletions={change.stagedDeletions}
                            label={t("staged")}
                          />
                        )}
                        {change.unstaged && (
                          <ChangeState
                            additions={change.unstagedAdditions}
                            deletions={change.unstagedDeletions}
                            label={t("unstaged")}
                          />
                        )}
                        {change.untracked && (
                          <ChangeState
                            additions={change.unstagedAdditions}
                            deletions={change.unstagedDeletions}
                            label={t("untracked")}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noChanges")}
            </p>
          )}
        </div>
      </section>
      <section className="w-full">
        <h4 className="mb-2 font-medium">
          {t("commits", { count: detail.commits.length })}
        </h4>
        <div className="max-h-80 overflow-auto rounded-md border">
          {detail.commits.length ? (
            <Table
              aria-label={t("commits", { count: detail.commits.length })}
              className="table-fixed text-xs"
            >
              <TableBody>
                {detail.commits.map((commit) => (
                  <TableRow key={commit.sha}>
                    <TableCell className="w-24 px-2 py-1.5 font-mono text-muted-foreground">
                      {commit.sha.slice(0, 8)}
                    </TableCell>
                    <TableCell className="max-w-0 px-2 py-1.5">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate font-medium">
                          {commit.subject}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {commit.authorName} ·{" "}
                          {new Date(commit.authoredAt).toLocaleString(locale)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="w-24 px-2 py-1.5 text-right">
                      <LineCounts
                        additions={commit.additions}
                        deletions={commit.deletions}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noCommits")}
            </p>
          )}
        </div>
      </section>
      {(detail.commitsTruncated || detail.changesTruncated) && (
        <p className="text-xs text-muted-foreground">{t("truncated")}</p>
      )}
    </div>
  );
}

function ChangeState({
  label,
  additions,
  deletions,
}: {
  label: string;
  additions: number | null;
  deletions: number | null;
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
      <span>{label}</span>
      <LineCounts additions={additions} deletions={deletions} />
    </span>
  );
}

function LineCounts({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  if (additions === null && deletions === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex gap-1 tabular-nums">
      <span className="text-emerald-700 dark:text-emerald-400">
        +{additions ?? 0}
      </span>
      <span className="text-red-700 dark:text-red-400">−{deletions ?? 0}</span>
    </span>
  );
}

function WorktreeTable(props: Omit<WorktreeItemProps, "worktree">) {
  const t = useTranslations("worktrees");
  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("branch")}</TableHead>
            <TableHead>{t("path")}</TableHead>
            <TableHead>{t("baseBranch")}</TableHead>
            <TableHead>{t("upToDate")}</TableHead>
            <TableHead>{t("tags")}</TableHead>
            <TableHead>{t("pullRequest")}</TableHead>
            <TableHead>{t("origin")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.group.worktrees.map((worktree) => (
            <WorktreeTableRows
              {...props}
              key={worktree.id}
              worktree={worktree}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function WorktreeTableRows(props: WorktreeItemProps) {
  const { baseRepoDirectory, inspectionRefreshToken, onError } = props;
  const { worktree, applyActivity, setUnstagedChanges } = useLiveWorktree(
    props.worktree,
  );
  const liveProps = { ...props, worktree };
  const t = useTranslations("worktrees");
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<WorktreeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);
  const lastInspectionRefreshToken = useRef(inspectionRefreshToken);
  const inspect = useCallback(async () => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    try {
      const next = await inspectWorktree(worktree.id);
      if (request !== detailRequest.current) return;
      setDetail(next);
      setUnstagedChanges(
        next.changes.some(
          (change) => change.unstaged || change.untracked || change.conflicted,
        ),
      );
      onError(null);
    } catch (value) {
      if (request === detailRequest.current)
        onError(value instanceof Error ? value.message : String(value));
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, [onError, setUnstagedChanges, worktree.id]);
  const refreshInspection = useQueuedWorktreeInspection(inspect);
  const handleActivity = useCallback(
    (activity: WorktreeActivity) => {
      applyActivity(activity);
      if (expanded) void refreshInspection();
    },
    [applyActivity, expanded, refreshInspection],
  );
  useWorktreeActivitySubscription(
    worktree.id,
    props.liveUpdatesEnabled && worktree.availability === "AVAILABLE",
    handleActivity,
  );
  useEffect(() => {
    if (lastInspectionRefreshToken.current === inspectionRefreshToken) return;
    lastInspectionRefreshToken.current = inspectionRefreshToken;
    if (!expanded) return;
    const timer = window.setTimeout(() => void refreshInspection(), 0);
    return () => window.clearTimeout(timer);
  }, [expanded, inspectionRefreshToken, refreshInspection]);
  const expand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) void refreshInspection();
  };
  const highlight =
    worktree.highlightColor && highlightColorClasses[worktree.highlightColor];
  return (
    <Fragment>
      <TableRow className={cn(highlight)}>
        <TableCell>
          <Button
            className="px-0 font-mono"
            onClick={() => void expand()}
            variant="ghost"
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            {worktree.branch ?? t("detached")}
          </Button>
          {(worktree.ticketKey || worktree.ticketTitle) && (
            <WorktreeTicketLink {...liveProps} compact />
          )}
        </TableCell>
        <TableCell className="font-mono text-xs">
          {displayedWorktreePath(worktree.folder, baseRepoDirectory)}
        </TableCell>
        <TableCell>
          <BaseBranchControl {...liveProps} compact />
        </TableCell>
        <TableCell>
          <BaseFreshnessBadge worktree={worktree} />
        </TableCell>
        <TableCell>
          <WorktreeTagsMenu {...liveProps} compact />
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1.5">
            <PullRequestBadges
              detailsExpanded={expanded}
              onToggleDetails={expand}
              worktree={worktree}
            />
          </div>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1">
            <OriginStatusBadges worktree={worktree} />
            {worktree.hasUnstagedChanges && (
              <Badge variant="destructive">{t("dirty")}</Badge>
            )}
          </div>
        </TableCell>
        <TableCell>
          <WorktreeMenus {...liveProps} />
        </TableCell>
      </TableRow>
      <TableRow className={cn(highlight)}>
        <TableCell colSpan={8}>
          <ActionRow
            {...liveProps}
            onCompleted={async () => {
              await props.onReload();
              if (expanded) await refreshInspection();
            }}
          />
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className={cn(highlight)}>
          <TableCell colSpan={8}>
            {detailLoading && !detail ? (
              <Spinner />
            ) : detail ? (
              <DetailPanel detail={detail} />
            ) : null}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function TagBadge({ tag }: { tag: WorktreeTag }) {
  return <Badge className={tagColorClasses[tag.color]}>{tag.name}</Badge>;
}

function Info({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "flex min-h-6 items-center truncate",
          mono && "font-mono text-xs",
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function TagManagerDialog({
  open,
  onOpenChange,
  tags,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: WorktreeTag[];
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("worktrees");
  const [editing, setEditing] = useState<WorktreeTag | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("blue");
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await controlPlaneRequest(
        `mutation SaveTag($input: SaveWorktreeTagInput!) { saveWorktreeTag(input: $input) { id } }`,
        { input: { id: editing?.id ?? null, name, color } },
      );
      setEditing(null);
      setName("");
      setColor("blue");
      setError(null);
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const remove = async (id: string) => {
    try {
      await controlPlaneRequest(
        "mutation DeleteTag($id: ID!) { deleteWorktreeTag(id: $id) }",
        { id },
      );
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("manageTags")}</DialogTitle>
          <DialogDescription>{t("manageTagsDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          {tags.map((tag) => (
            <div
              className="flex items-center gap-2 rounded border p-2"
              key={tag.id}
            >
              <TagBadge tag={tag} />
              <span className="flex-1" />
              <Button
                onClick={() => {
                  setEditing(tag);
                  setName(tag.name);
                  setColor(tag.color);
                }}
                size="sm"
                variant="outline"
              >
                {t("edit")}
              </Button>
              <Button
                onClick={() => void remove(tag.id)}
                size="icon-sm"
                variant="destructive"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <form className="space-y-3 border-t pt-3" onSubmit={save}>
          <Label htmlFor="tag-name">
            {editing ? t("editTag") : t("createTag")}
          </Label>
          <Input
            id="tag-name"
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
          <div className="grid grid-cols-12 gap-1">
            {COLORS.map((item) => (
              <button
                aria-label={item}
                className={cn(
                  "size-7 rounded border",
                  colorSwatchClasses[item],
                  color === item && "ring-2 ring-foreground",
                )}
                key={item}
                onClick={() => setColor(item)}
                type="button"
              />
            ))}
          </div>
          <DialogFooter>
            <Button type="submit">
              <Save /> {t("saveTag")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HiddenWorktreesDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("worktrees");
  const [items, setItems] = useState<Worktree[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{ hiddenWorktrees: Worktree[] }>(
        `query HiddenWorktrees { hiddenWorktrees { ${WORKTREE_FIELDS} } }`,
      );
      setItems(data.hiddenWorktrees);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);
  const purge = async (id?: string) => {
    try {
      await controlPlaneRequest(
        id
          ? "mutation PurgeHidden($id: ID!) { purgeHiddenWorktree(id: $id) }"
          : "mutation PurgeAllHidden { purgeAllHiddenWorktrees }",
        id ? { id } : undefined,
      );
      await load();
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("hiddenTitle")}</DialogTitle>
          <DialogDescription>{t("hiddenDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {items.length ? (
            items.map((item) => (
              <div
                className="flex items-center gap-3 rounded border p-3"
                key={item.id}
              >
                <GitBranch />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">
                    {item.branch ?? t("detached")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.folder}
                  </p>
                </div>
                <Button
                  onClick={() => void purge(item.id)}
                  size="sm"
                  variant="destructive"
                >
                  <Trash2 /> {t("purge")}
                </Button>
              </div>
            ))
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("noHidden")}
            </p>
          )}
        </div>
        <DialogFooter>
          {items.length > 0 && (
            <Button onClick={() => void purge()} variant="destructive">
              <Trash2 /> {t("purgeAll")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
