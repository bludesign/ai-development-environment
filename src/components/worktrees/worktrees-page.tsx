"use client";

import {
  Archive,
  ArrowDown,
  ArrowRight,
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
  MoveRight,
  Paintbrush,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
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
  useMemo,
  useRef,
  useState,
} from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import { buildStatusVariant } from "@/components/builds/build-format";
import { RebuildButton } from "@/components/builds/rebuild-button";
import { RunBuildControls } from "@/components/builds/run-build-controls";
import { StartBuildButton } from "@/components/builds/start-build-dialog";
import { MergePullRequestButton } from "@/components/github/merge-pull-request-button";
import { PipelineMenu } from "@/components/github/pipeline-menu";
import {
  pullRequestCommentsHref,
  pullRequestDetailHref,
} from "@/components/github/pull-request-links";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/common/searchable-select";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { createClientId } from "@/lib/browser-utils";
import { formatDateValue } from "@/lib/date-format";
import { worktreeHighlightSurfaceClasses } from "@/lib/worktree-highlight";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import { Link, useRouter } from "@/i18n/navigation";

import {
  WorktreeBranchForm,
  type WorktreeBranchSelection,
  type WorktreeBranchTarget,
} from "./worktree-branch-form";
import { WorktreeDetailPanel } from "./worktree-detail-panel";
import { CODEBASE_FIELDS, WORKTREE_FIELDS } from "./worktree-graphql";
import {
  inspectWorktree,
  useLiveWorktree,
  useQueuedWorktreeInspection,
  useWorktreeActivitySubscription,
  type WorktreeActivity,
} from "./worktree-inspection";
import { waitForWorktreeJob, waitForWorktreeMove } from "./worktree-jobs";
import {
  shouldNavigateWorktreeSurface,
  worktreeDetailHref,
} from "./worktree-navigation";

import type {
  Worktree,
  WorktreeAgentGroup,
  WorktreeCodebaseGroup,
  WorktreeDetail,
  WorktreeLatestBuild,
  WorktreeMove,
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
const ALL_FILTER_VALUE = "__all__";

export type WorktreeListFilters = {
  query: string;
  agentId: string | null;
  repositoryId: string | null;
};

function matchesWorktreeSearch(values: Array<unknown>, query: string) {
  return values.some(
    (value) =>
      (typeof value === "string" || typeof value === "number") &&
      String(value).toLocaleLowerCase().includes(query),
  );
}

export function filterWorktreeAgentGroups(
  agents: WorktreeAgentGroup[],
  filters: WorktreeListFilters,
): WorktreeAgentGroup[] {
  const query = filters.query.trim().toLocaleLowerCase();
  if (!query && !filters.agentId && !filters.repositoryId) return agents;
  return agents.flatMap((agentGroup) => {
    if (filters.agentId && agentGroup.agent.id !== filters.agentId) return [];
    const agentMatches =
      query.length > 0 &&
      matchesWorktreeSearch(
        [agentGroup.agent.id, agentGroup.agent.name, agentGroup.agent.hostname],
        query,
      );
    const codebases = agentGroup.codebases.flatMap((group) => {
      if (
        filters.repositoryId &&
        group.repository.id !== filters.repositoryId
      ) {
        return [];
      }
      const groupMatches =
        query.length > 0 &&
        matchesWorktreeSearch(
          [
            group.repository.id,
            group.repository.name,
            group.repository.description,
            group.repository.canonicalOrigin,
            group.repository.displayOrigin,
            group.codebase.id,
            group.codebase.folder,
            group.codebase.observedOrigin,
            group.codebase.branch,
            group.codebase.defaultBranch,
          ],
          query,
        );
      const worktrees =
        !query || agentMatches || groupMatches
          ? group.worktrees
          : group.worktrees.filter((worktree) =>
              matchesWorktreeSearch(
                [
                  worktree.id,
                  worktree.branch,
                  worktree.folder,
                  worktree.relativePath,
                  worktree.ticketKey,
                  worktree.ticketTitle,
                  worktree.ticketStatus,
                  worktree.pullRequest?.number,
                  worktree.pullRequest?.title,
                  worktree.pullRequest?.repositoryNameWithOwner,
                  worktree.pullRequest?.jiraKey,
                  ...worktree.tags.map((tag) => tag.name),
                ],
                query,
              ),
            );
      return worktrees.length ? [{ ...group, worktrees }] : [];
    });
    return codebases.length ? [{ ...agentGroup, codebases }] : [];
  });
}

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
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState(ALL_FILTER_VALUE);
  const [repositoryFilter, setRepositoryFilter] = useState(ALL_FILTER_VALUE);
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
            activeMoves {
              id sourceWorktreeId sourceCodebaseId targetCodebaseId targetWorktreeId destinationMode
              branch headSha deleteSource status sourceJobId targetJobId cleanupJobId error warning
              createdAt updatedAt finishedAt
            }
            agents {
              agent { ${AGENT_FIELDS} }
              codebases {
                iosBuildConfigured
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
    const subscriptions = controlPlaneSubscriptions();
    const unsubscribeWorktrees = subscriptions.subscribe(
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
    const unsubscribeBuilds = subscriptions.subscribe(
      { query: "subscription WorktreeBuildsChanged { buildsChanged { id } }" },
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
      unsubscribeWorktrees();
      unsubscribeBuilds();
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

  const repositoryOptions = useMemo(() => {
    const repositories = new Map<string, { id: string; name: string }>();
    overview?.agents.forEach((agentGroup) =>
      agentGroup.codebases.forEach((group) =>
        repositories.set(group.repository.id, {
          id: group.repository.id,
          name: group.repository.name,
        }),
      ),
    );
    return [...repositories.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [overview]);
  const filteredAgents = useMemo(
    () =>
      filterWorktreeAgentGroups(overview?.agents ?? [], {
        query,
        agentId: agentFilter === ALL_FILTER_VALUE ? null : agentFilter,
        repositoryId:
          repositoryFilter === ALL_FILTER_VALUE ? null : repositoryFilter,
      }),
    [agentFilter, overview, query, repositoryFilter],
  );
  const filtersActive =
    Boolean(query.trim()) ||
    agentFilter !== ALL_FILTER_VALUE ||
    repositoryFilter !== ALL_FILTER_VALUE;

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
          <ToggleGroup
            aria-label={`${t("cards")} / ${t("table")}`}
            onValueChange={(value) => {
              if (value === "cards" || value === "table") {
                setLayoutAndRemember(value);
              }
            }}
            size="sm"
            spacing={0}
            type="single"
            value={layout}
            variant="outline"
          >
            <ToggleGroupItem
              aria-label={t("cards")}
              className="px-2"
              value="cards"
            >
              <Grid2X2 />
            </ToggleGroupItem>
            <ToggleGroupItem
              aria-label={t("table")}
              className="px-2"
              value="table"
            >
              <List />
            </ToggleGroupItem>
          </ToggleGroup>
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

      {overview && overview.agents.length > 0 && (
        <div
          aria-label={t("filters")}
          className="flex flex-wrap gap-2"
          role="search"
        >
          <div className="relative min-w-0 flex-[2_1_18rem]">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("searchWorktrees")}
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchWorktreesPlaceholder")}
              type="search"
              value={query}
            />
          </div>
          <div className="min-w-0 flex-[1_1_12rem]">
            <Select onValueChange={setAgentFilter} value={agentFilter}>
              <SelectTrigger aria-label={t("filterByAgent")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER_VALUE}>
                  {t("allAgents")}
                </SelectItem>
                {overview.agents.map((agentGroup) => (
                  <SelectItem
                    key={agentGroup.agent.id}
                    value={agentGroup.agent.id}
                  >
                    {agentGroup.agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 flex-[1_1_12rem]">
            <Select
              onValueChange={setRepositoryFilter}
              value={repositoryFilter}
            >
              <SelectTrigger
                aria-label={t("filterByRepository")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER_VALUE}>
                  {t("allRepositories")}
                </SelectItem>
                {repositoryOptions.map((repository) => (
                  <SelectItem key={repository.id} value={repository.id}>
                    {repository.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {overview && overview.activeMoves.length > 0 && (
        <ActiveWorktreeMoves
          moves={overview.activeMoves}
          onError={setError}
          onNotice={setNotice}
          onReload={load}
        />
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
      ) : filtersActive && filteredAgents.length === 0 ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>{t("noMatchingWorktrees")}</EmptyTitle>
            <EmptyDescription>
              {t("noMatchingWorktreesDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        filteredAgents.map((agentGroup) => (
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
            overview={overview}
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

function ActiveWorktreeMoves({
  moves,
  onReload,
  onError,
  onNotice,
}: {
  moves: WorktreeMove[];
  onReload: () => Promise<void>;
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
}) {
  const t = useTranslations("worktrees");
  const [busyId, setBusyId] = useState<string | null>(null);
  const retry = async (move: WorktreeMove) => {
    setBusyId(move.id);
    try {
      await controlPlaneRequest(
        `mutation RetryWorktreeMove($id: ID!) {
          retryWorktreeMoveWithStash(id: $id) { id status }
        }`,
        { id: move.id },
      );
      const completed = await waitForWorktreeMove(move.id);
      if (completed.status === "FAILED") {
        throw new Error(completed.error || t("moveFailed"));
      }
      onNotice(
        completed.status === "SUCCEEDED_WITH_WARNING"
          ? completed.warning || t("moveCompletedWithWarning")
          : t("moveCompleted"),
      );
      onError(null);
      await onReload();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };
  const cancel = async (move: WorktreeMove) => {
    setBusyId(move.id);
    try {
      await controlPlaneRequest(
        `mutation CancelWorktreeMove($id: ID!) {
          cancelWorktreeMove(id: $id) { id status }
        }`,
        { id: move.id },
      );
      onNotice(t("moveCancelled"));
      onError(null);
      await onReload();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="space-y-2">
      {moves.map((move) => (
        <Alert key={move.id}>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">
                {t("moveProgress", { branch: move.branch })}
              </p>
              <p className="text-muted-foreground">
                {move.status === "AWAITING_STASH"
                  ? move.error || t("moveNeedsStash")
                  : t(`moveStatus.${move.status}`)}
              </p>
            </div>
            {move.status === "AWAITING_STASH" ? (
              <div className="flex gap-2">
                <Button
                  disabled={busyId === move.id}
                  onClick={() => void cancel(move)}
                  size="sm"
                  variant="outline"
                >
                  {t("cancelMove")}
                </Button>
                <Button
                  disabled={busyId === move.id}
                  onClick={() => void retry(move)}
                  size="sm"
                >
                  {busyId === move.id && <Spinner />}
                  {t("stashAndContinue")}
                </Button>
              </div>
            ) : (
              <Spinner />
            )}
          </AlertDescription>
        </Alert>
      ))}
    </div>
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
      <CardHeader>
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
  overview,
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
  overview: WorktreeOverview;
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
        <Badge
          variant={
            agentGroup.agent.connectionStatus === "ONLINE"
              ? "success"
              : "secondary"
          }
        >
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
                  overview={overview}
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
              overview={overview}
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
        : formatDateValue(codebase.lastFetchedAt, "relative", {
            locale,
            now: now ?? undefined,
          });
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
  const router = useRouter();
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
        "cursor-pointer transition-colors hover:bg-muted/30",
        worktree.highlightColor &&
          worktreeHighlightSurfaceClasses[worktree.highlightColor],
      )}
      onClick={(event) => {
        if (shouldNavigateWorktreeSurface(event)) {
          router.push(worktreeDetailHref(worktree.id));
        }
      }}
    >
      <CardHeader className="grid-cols-1! @md/card-header:grid-cols-[minmax(0,1fr)_auto]!">
        <CardTitle className="min-w-0">
          <Button
            aria-expanded={expanded}
            className="h-auto w-full max-w-full justify-start gap-1 p-1 text-left"
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
        <CardAction className="col-start-1 row-span-1 row-start-auto flex max-w-full flex-wrap items-center justify-start gap-1 justify-self-start @md/card-header:col-start-2 @md/card-header:row-span-2 @md/card-header:row-start-1 @md/card-header:justify-end @md/card-header:justify-self-end">
          <OriginStatusBadges worktree={worktree} />
          {worktree.hasUnstagedChanges && (
            <Badge variant="destructive">{t("dirty")}</Badge>
          )}
          <WorktreeDetailsLink worktree={worktree} />
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
        {expanded && detail && <WorktreeDetailPanel detail={detail} inline />}
      </CardContent>
      <CardFooter className="flex-wrap gap-2" data-worktree-navigation-ignore>
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

export type WorktreeItemProps = {
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
  onDeleted?: () => void;
  onMoved?: (move: WorktreeMove) => void;
  overview: WorktreeOverview;
};

function WorktreeDetailsLink({ worktree }: { worktree: Worktree }) {
  const t = useTranslations("worktrees");
  const branch =
    worktree.branch ?? worktree.headSha?.slice(0, 10) ?? t("detached");
  const label = t("openWorktreeDetails", { branch });
  return (
    <Button asChild size="icon-sm" variant="ghost">
      <Link
        aria-label={label}
        href={worktreeDetailHref(worktree.id)}
        title={label}
      >
        <ArrowRight />
      </Link>
    </Button>
  );
}

export function WorktreeTicketLink({
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
        "flex max-w-full flex-wrap items-center gap-1.5 font-normal",
        compact ? "mt-0.5 text-xs" : "mt-1 text-sm",
      )}
    >
      {!worktree.ticketKey ? (
        <p className="min-w-0 truncate text-muted-foreground" title={label}>
          {label}
        </p>
      ) : (
        <Button
          className="h-auto min-w-0 justify-start truncate p-0 text-left font-normal"
          onClick={() => onOpenTicket(worktree.ticketKey!)}
          title={label}
          type="button"
          variant="link"
        >
          {label}
        </Button>
      )}
      {worktree.ticketStatus &&
        (worktree.ticketKey ? (
          <Badge asChild variant="secondary">
            <button
              onClick={() => onOpenTicket(worktree.ticketKey!)}
              type="button"
            >
              {worktree.ticketStatus}
            </button>
          </Badge>
        ) : (
          <Badge variant="secondary">{worktree.ticketStatus}</Badge>
        ))}
    </div>
  );
}

export function WorktreeMetadata(
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
      {worktree.latestBuild && (
        <LatestBuildRow
          build={worktree.latestBuild}
          onCompleted={props.onReload}
          onError={props.onError}
        />
      )}
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

function LatestBuildRow({
  build,
  onCompleted,
  onError,
}: {
  build: WorktreeLatestBuild;
  onCompleted: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("worktrees");
  const buildsT = useTranslations("builds");
  const runnable =
    build.status === "SUCCEEDED" &&
    build.artifacts.some((artifact) => artifact.kind === "RUNNABLE_APP");
  return (
    <MetadataRow label={t("latestBuild")}>
      <Badge asChild variant="outline">
        <Link href={`/builds/${build.id}`}>
          {buildsT(`actions.${build.action}`)}
        </Link>
      </Badge>
      <Badge variant={buildStatusVariant(build.status)}>
        {buildsT(`statuses.${build.status}`)}
      </Badge>
      {build.outOfDate && (
        <Badge
          className="border-amber-500/40 text-amber-700 dark:text-amber-300"
          variant="outline"
        >
          {buildsT("outOfDate")}
        </Badge>
      )}
      <RebuildButton
        buildId={build.id}
        onCompleted={() => onCompleted()}
        onError={onError}
        size="sm"
      />
      {runnable && (
        <RunBuildControls
          buildId={build.id}
          destinationType={build.destinationType}
          onCompleted={onCompleted}
          onError={onError}
          preferredDestination={build.destination}
          size="sm"
        />
      )}
    </MetadataRow>
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

export function WorktreeTagsMenu({
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
          <Button
            aria-label={`${t("tags")}: ${worktree.branch ?? t("detached")}`}
            className={cn(
              "h-auto min-h-7 max-w-full justify-start px-1 py-1 text-left font-normal",
              !compact && "-mx-1",
            )}
            type="button"
            variant="ghost"
          >
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {worktree.tags.map((tag) => (
                <TagBadge key={tag.id} tag={tag} />
              ))}
              {!worktree.tags.length && (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
          </Button>
        }
      />
    </div>
  );
}

export function BaseFreshnessBadge({ worktree }: { worktree: Worktree }) {
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

export function PullRequestBadges({
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
          <Badge
            asChild
            className={
              worktree.pullRequest.unresolvedReviewThreadCount === 0
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            }
          >
            <Link href={pullRequestCommentsHref(worktree.pullRequest)}>
              {t("comments", {
                count: worktree.pullRequest.unresolvedReviewThreadCount,
              })}
            </Link>
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
          <Link href={pullRequestDetailHref(pullRequest)}>
            <GitPullRequest />
            {t("openDetails")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OriginStatusBadges({ worktree }: { worktree: Worktree }) {
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

export function BaseBranchControl(
  props: WorktreeItemProps & { compact?: boolean },
) {
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

type MoveTargetEntry = {
  agentGroup: WorktreeAgentGroup;
  group: WorktreeCodebaseGroup;
};

function moveTargets(props: WorktreeItemProps): MoveTargetEntry[] {
  const sourceAgent = props.overview.agents.find((agentGroup) =>
    agentGroup.codebases.some(
      (group) => group.codebase.id === props.group.codebase.id,
    ),
  );
  if (!sourceAgent) return [];
  return props.overview.agents.flatMap((agentGroup) =>
    agentGroup.agent.id === sourceAgent.agent.id
      ? []
      : agentGroup.codebases.flatMap((group) =>
          group.repository.id === props.group.repository.id
            ? [{ agentGroup, group }]
            : [],
        ),
  );
}

function targetAvailable(entry: MoveTargetEntry, overview: WorktreeOverview) {
  const busyMove = overview.activeMoves.some(
    (move) =>
      move.sourceCodebaseId === entry.group.codebase.id ||
      move.targetCodebaseId === entry.group.codebase.id,
  );
  return (
    entry.agentGroup.agent.connectionStatus === "ONLINE" &&
    entry.agentGroup.agent.capabilities.includes("worktree.move.checkout") &&
    entry.group.codebase.availability === "AVAILABLE" &&
    !entry.group.worktrees.some((worktree) => worktree.activeJob) &&
    !busyMove
  );
}

function moveDisabledReason(
  props: WorktreeItemProps,
  targets: MoveTargetEntry[],
  t: ReturnType<typeof useTranslations<"worktrees">>,
) {
  const sourceAgent = props.overview.agents.find((agentGroup) =>
    agentGroup.codebases.some(
      (group) => group.codebase.id === props.group.codebase.id,
    ),
  );
  if (
    !sourceAgent ||
    sourceAgent.agent.connectionStatus !== "ONLINE" ||
    !sourceAgent.agent.capabilities.includes("worktree.move.push")
  ) {
    return t("moveBlocked.agent");
  }
  if (
    props.worktree.availability !== "AVAILABLE" ||
    props.worktree.activeJob ||
    props.overview.activeMoves.some(
      (move) =>
        move.sourceCodebaseId === props.group.codebase.id ||
        move.targetCodebaseId === props.group.codebase.id,
    )
  ) {
    return t("moveBlocked.busy");
  }
  if (!props.worktree.branch || !props.worktree.headSha) {
    return t("moveBlocked.detached");
  }
  if (
    props.worktree.hasStagedChanges ||
    props.worktree.hasUnstagedChanges ||
    props.worktree.pushStatus === "DIRTY"
  ) {
    return t("moveBlocked.dirty");
  }
  if (props.worktree.pushStatus === "BEHIND") {
    return t("moveBlocked.behind");
  }
  if (props.worktree.pushStatus === "DIVERGED") {
    return t("moveBlocked.diverged");
  }
  if (props.worktree.pushStatus !== "READY") {
    return t("moveBlocked.unknown");
  }
  if (!targets.some((entry) => targetAvailable(entry, props.overview))) {
    return t("moveBlocked.destination");
  }
  return null;
}

export function WorktreeMenus(
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
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [changeBusy, setChangeBusy] = useState(false);
  const [failedSelection, setFailedSelection] =
    useState<WorktreeBranchSelection | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const openChangeBranchOnMenuClose = useRef(false);
  const targets = moveTargets(props);
  const moveReason = moveDisabledReason(props, targets, t);
  const sourceAgent = props.overview.agents.find((agentGroup) =>
    agentGroup.codebases.some(
      (group) => group.codebase.id === props.group.codebase.id,
    ),
  );
  const deleteDisabled =
    !sourceAgent ||
    sourceAgent.agent.connectionStatus !== "ONLINE" ||
    !sourceAgent.agent.capabilities.includes("worktree.delete") ||
    worktree.availability !== "AVAILABLE" ||
    Boolean(worktree.activeJob) ||
    props.overview.activeMoves.some(
      (move) =>
        move.sourceCodebaseId === props.group.codebase.id ||
        move.targetCodebaseId === props.group.codebase.id,
    );
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
    <>
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
            {targets.length > 0 && (
              <DropdownMenuItem
                disabled={Boolean(moveReason)}
                onSelect={() => setMoveOpen(true)}
                title={moveReason ?? undefined}
              >
                <MoveRight /> {t("moveToAgent")}
              </DropdownMenuItem>
            )}
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
            <ToggleGroup
              aria-label={t("highlight")}
              className="grid grid-cols-7 gap-1 p-2"
              onClick={(event) => event.stopPropagation()}
              onValueChange={(value) => {
                if (value) void highlight(value === "__none__" ? null : value);
              }}
              size="sm"
              spacing={1}
              type="single"
              value={worktree.highlightColor ?? "__none__"}
              variant="outline"
            >
              <ToggleGroupItem
                aria-label={t("clearHighlight")}
                className="size-7 min-w-0 p-0"
                value="__none__"
              >
                <Trash2 className="size-3" />
              </ToggleGroupItem>
              {COLORS.map((color) => (
                <ToggleGroupItem
                  aria-label={color}
                  className={cn(
                    "size-7 min-w-0 p-0",
                    colorSwatchClasses[color],
                    "data-[state=on]:ring-2 data-[state=on]:ring-foreground",
                  )}
                  key={color}
                  value={color}
                />
              ))}
            </ToggleGroup>
            {!worktree.primary && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={deleteDisabled}
                  onSelect={() => setDeleteOpen(true)}
                  variant="destructive"
                >
                  <Trash2 /> {t("deleteWorktree")}
                </DropdownMenuItem>
              </>
            )}
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
      {moveOpen && (
        <MoveWorktreeDialog
          onOpenChange={setMoveOpen}
          open={moveOpen}
          props={props}
          targets={targets.filter((entry) =>
            targetAvailable(entry, props.overview),
          )}
        />
      )}
      {!worktree.primary && deleteOpen && (
        <DeleteWorktreeDialog
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          props={props}
        />
      )}
    </>
  );
}

function MoveWorktreeDialog({
  props,
  targets,
  open,
  onOpenChange,
}: {
  props: WorktreeItemProps;
  targets: MoveTargetEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("worktrees");
  const initialTargetId =
    targets.length === 1 ? targets[0]!.group.codebase.id : "";
  const [targetCodebaseId, setTargetCodebaseId] = useState(initialTargetId);
  const [destination, setDestination] = useState("__new__");
  const [deleteSource, setDeleteSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingMove, setAwaitingMove] = useState<WorktreeMove | null>(null);
  const effectiveTargetId = targets.some(
    (entry) => entry.group.codebase.id === targetCodebaseId,
  )
    ? targetCodebaseId
    : targets.length === 1
      ? targets[0]!.group.codebase.id
      : "";
  const selected = targets.find(
    (entry) => entry.group.codebase.id === effectiveTargetId,
  );
  const options: SearchableSelectOption[] = targets.map((entry) => ({
    value: entry.group.codebase.id,
    label: `${entry.agentGroup.agent.name} · ${entry.group.repository.name}`,
    description: entry.group.codebase.folder,
    keywords: `${entry.agentGroup.agent.hostname} ${entry.group.repository.displayOrigin}`,
  }));
  const selectedWorktree = selected?.group.worktrees.find(
    (worktree) => worktree.id === destination,
  );
  const branchHolder = selected?.group.worktrees.find(
    (worktree) => worktree.branch === props.worktree.branch,
  );
  const canDeleteSource =
    !props.worktree.primary &&
    props.overview.agents.some(
      (agentGroup) =>
        agentGroup.codebases.some(
          (group) => group.codebase.id === props.group.codebase.id,
        ) && agentGroup.agent.capabilities.includes("worktree.delete"),
    );

  const finish = async (move: WorktreeMove) => {
    if (move.status === "AWAITING_STASH") {
      setAwaitingMove(move);
      await props.onReload();
      return;
    }
    if (move.status === "FAILED") {
      throw new Error(move.error || t("moveFailed"));
    }
    if (move.status === "CANCELLED") {
      throw new Error(t("moveCancelled"));
    }
    props.onError(
      move.status === "SUCCEEDED_WITH_WARNING" ? move.warning : null,
    );
    await props.onReload();
    props.onMoved?.(move);
    onOpenChange(false);
  };
  const start = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        moveWorktree: WorktreeMove;
      }>(
        `mutation MoveWorktree($input: MoveWorktreeInput!) {
          moveWorktree(input: $input) {
            id sourceWorktreeId sourceCodebaseId targetCodebaseId targetWorktreeId destinationMode
            branch headSha deleteSource status sourceJobId targetJobId cleanupJobId error warning
            createdAt updatedAt finishedAt
          }
        }`,
        {
          input: {
            sourceWorktreeId: props.worktree.id,
            targetCodebaseId: selected.group.codebase.id,
            targetWorktreeId: destination === "__new__" ? null : destination,
            deleteSource,
            requestId: createClientId(),
          },
        },
      );
      await finish(await waitForWorktreeMove(data.moveWorktree.id));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    if (!awaitingMove) return;
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation RetryMove($id: ID!) {
          retryWorktreeMoveWithStash(id: $id) { id status }
        }`,
        { id: awaitingMove.id },
      );
      await finish(await waitForWorktreeMove(awaitingMove.id));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!awaitingMove) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation CancelMove($id: ID!) {
          cancelWorktreeMove(id: $id) { id status }
        }`,
        { id: awaitingMove.id },
      );
      await props.onReload();
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("moveToAgent")}</DialogTitle>
          <DialogDescription>
            {t("moveDescription", { branch: props.worktree.branch ?? "" })}
          </DialogDescription>
        </DialogHeader>
        {awaitingMove ? (
          <Alert>
            <AlertDescription className="space-y-3">
              <p>{awaitingMove.error || t("moveNeedsStash")}</p>
              <p className="text-muted-foreground">{t("moveStashHelp")}</p>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <div>
              <Label className="mb-1.5 block">{t("destinationAgent")}</Label>
              <SearchableSelect
                ariaLabel={t("destinationAgent")}
                disabled={busy}
                emptyMessage={t("noMoveDestinations")}
                onValueChange={(value) => {
                  setTargetCodebaseId(value);
                  setDestination("__new__");
                }}
                options={options}
                placeholder={t("selectDestinationAgent")}
                searchPlaceholder={t("searchDestinationAgents")}
                value={effectiveTargetId}
              />
            </div>
            {selected && (
              <div>
                <Label className="mb-1.5 block">
                  {t("destinationWorktree")}
                </Label>
                <Select
                  disabled={busy}
                  onValueChange={setDestination}
                  value={destination}
                >
                  <SelectTrigger aria-label={t("destinationWorktree")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      disabled={Boolean(branchHolder)}
                      value="__new__"
                    >
                      {t("createDestinationWorktree")}
                    </SelectItem>
                    {selected.group.worktrees
                      .filter(
                        (worktree) => worktree.availability === "AVAILABLE",
                      )
                      .map((worktree) => (
                        <SelectItem
                          disabled={
                            Boolean(branchHolder) &&
                            branchHolder!.id !== worktree.id
                          }
                          key={worktree.id}
                          value={worktree.id}
                        >
                          {worktree.branch ?? t("detached")} ·{" "}
                          {worktree.relativePath}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {selectedWorktree &&
              (selectedWorktree.hasStagedChanges ||
                selectedWorktree.hasUnstagedChanges) && (
                <Alert>
                  <AlertDescription>
                    {t("dirtyDestinationWarning")}
                  </AlertDescription>
                </Alert>
              )}
            <div className="flex items-start gap-2">
              <Checkbox
                checked={deleteSource}
                disabled={!canDeleteSource || busy}
                id={`delete-source-${props.worktree.id}`}
                onCheckedChange={(checked) => setDeleteSource(Boolean(checked))}
              />
              <div>
                <Label htmlFor={`delete-source-${props.worktree.id}`}>
                  {t("deleteOldWorktree")}
                </Label>
                {!canDeleteSource && (
                  <p className="text-xs text-muted-foreground">
                    {t("deleteOldWorktreeDisabled")}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() => (awaitingMove ? void cancel() : onOpenChange(false))}
            variant="outline"
          >
            {awaitingMove ? t("cancelMove") : t("cancel")}
          </Button>
          <Button
            disabled={busy || (!awaitingMove && !selected)}
            onClick={() => (awaitingMove ? void retry() : void start())}
          >
            {busy && <Spinner />}
            {awaitingMove ? t("stashAndContinue") : t("moveWorktree")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteWorktreeDialog({
  props,
  open,
  onOpenChange,
}: {
  props: WorktreeItemProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("worktrees");
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remoteExists = Boolean(
    props.worktree.branch &&
    (props.group.codebase.remoteBranches.includes(props.worktree.branch) ||
      props.worktree.upstream === `origin/${props.worktree.branch}`),
  );
  const defaultRemote =
    props.worktree.branch === props.group.codebase.defaultBranch;
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        deleteWorktree: { id: string };
      }>(
        `mutation DeleteWorktree($input: DeleteWorktreeInput!) {
          deleteWorktree(input: $input) { id }
        }`,
        {
          input: {
            worktreeId: props.worktree.id,
            deleteRemoteBranch: deleteRemote,
            requestId: createClientId(),
          },
        },
      );
      await waitForWorktreeJob(data.deleteWorktree.id);
      await props.onReload();
      props.onError(null);
      props.onDeleted?.();
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deleteWorktree")}</DialogTitle>
          <DialogDescription>
            {t("deleteWorktreeDescription", {
              path: displayedWorktreePath(
                props.worktree.folder,
                props.baseRepoDirectory,
              ),
            })}
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertDescription>{t("deleteWorktreeWarning")}</AlertDescription>
        </Alert>
        {remoteExists && (
          <div className="flex items-start gap-2">
            <Checkbox
              checked={deleteRemote}
              disabled={busy || defaultRemote}
              id={`delete-remote-${props.worktree.id}`}
              onCheckedChange={(checked) => setDeleteRemote(Boolean(checked))}
            />
            <div>
              <Label htmlFor={`delete-remote-${props.worktree.id}`}>
                {t("deleteRemoteBranch", {
                  branch: props.worktree.branch ?? "",
                })}
              </Label>
              {defaultRemote && (
                <p className="text-xs text-muted-foreground">
                  {t("defaultRemoteProtected")}
                </p>
              )}
            </div>
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void remove()}
            variant="destructive"
          >
            {busy && <Spinner />}
            {t("deleteWorktree")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ActionRow(
  props: WorktreeItemProps & { onCompleted: () => Promise<void> },
) {
  const { worktree, editorVariant } = props;
  const t = useTranslations("worktrees");
  const unavailable =
    worktree.availability !== "AVAILABLE" || Boolean(worktree.activeJob);
  const changeActions = worktreeChangeActionState(worktree);
  const agent = props.overview.agents.find((entry) =>
    entry.codebases.some(
      (codebase) => codebase.codebase.id === props.group.codebase.id,
    ),
  )?.agent;
  const buildDisabledForSettings =
    agent?.connectionStatus === "ONLINE" &&
    agent.capabilities.includes("ios.build.run") &&
    props.group.iosBuildConfigured === false;
  const buildUnavailable =
    worktree.availability !== "AVAILABLE" ||
    !agent ||
    agent.connectionStatus !== "ONLINE" ||
    !agent.capabilities.includes("ios.build.run") ||
    props.group.iosBuildConfigured === false;
  return (
    <div className="flex flex-wrap gap-2">
      <StartBuildButton
        buildSettingsHref={
          buildDisabledForSettings
            ? `/codebases/repositories/${props.group.repository.id}`
            : undefined
        }
        codebaseId={props.group.codebase.id}
        disabled={buildUnavailable}
        disabledReason={
          !agent || agent.connectionStatus !== "ONLINE"
            ? t("agentOffline")
            : !agent.capabilities.includes("ios.build.run")
              ? t("agentUnsupported")
              : props.group.iosBuildConfigured === false
                ? t("iosBuildNotConfigured")
                : worktree.availability !== "AVAILABLE"
                  ? t("worktreeUnavailable")
                  : null
        }
        worktreeId={worktree.id}
      />
      {worktree.pullRequest && (
        <MergePullRequestButton
          onMerged={props.onCompleted}
          pullRequest={worktree.pullRequest}
        />
      )}
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
  const router = useRouter();
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
    worktree.highlightColor &&
    worktreeHighlightSurfaceClasses[worktree.highlightColor];
  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer transition-colors hover:bg-muted/50",
          highlight,
        )}
        onClick={(event) => {
          if (shouldNavigateWorktreeSurface(event)) {
            router.push(worktreeDetailHref(worktree.id));
          }
        }}
      >
        <TableCell>
          <Button
            aria-expanded={expanded}
            className="max-w-full px-0 font-mono"
            onClick={() => void expand()}
            variant="ghost"
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            <span className="truncate">{worktree.branch ?? t("detached")}</span>
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
          <div className="flex items-center justify-end gap-1">
            <WorktreeDetailsLink worktree={worktree} />
            <WorktreeMenus {...liveProps} />
          </div>
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
              <WorktreeDetailPanel detail={detail} inline />
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

export function TagManagerDialog({
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
        <ItemGroup className="gap-2">
          {tags.map((tag) => (
            <Item key={tag.id} size="sm" variant="outline">
              <ItemContent>
                <ItemTitle>
                  <TagBadge tag={tag} />
                </ItemTitle>
              </ItemContent>
              <ItemActions>
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
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
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
          <ToggleGroup
            aria-label={t("highlight")}
            className="grid grid-cols-12 gap-1"
            onValueChange={(value) => {
              if (value) setColor(value);
            }}
            size="sm"
            spacing={1}
            type="single"
            value={color}
            variant="outline"
          >
            {COLORS.map((item) => (
              <ToggleGroupItem
                aria-label={item}
                className={cn(
                  "size-7 min-w-0 p-0",
                  colorSwatchClasses[item],
                  "data-[state=on]:ring-2 data-[state=on]:ring-foreground",
                )}
                key={item}
                value={item}
              />
            ))}
          </ToggleGroup>
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
        <div className="max-h-96 overflow-y-auto">
          {items.length ? (
            <ItemGroup className="gap-2">
              {items.map((item) => (
                <Item key={item.id} variant="outline">
                  <ItemMedia variant="icon">
                    <GitBranch />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="font-mono">
                      {item.branch ?? t("detached")}
                    </ItemTitle>
                    <ItemDescription className="truncate" title={item.folder}>
                      {item.folder}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => void purge(item.id)}
                      size="sm"
                      variant="destructive"
                    >
                      <Trash2 /> {t("purge")}
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <Empty className="border-0 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Archive />
                </EmptyMedia>
                <EmptyTitle>{t("noHidden")}</EmptyTitle>
              </EmptyHeader>
            </Empty>
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
