"use client";

import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  GitBranch,
  Grid2X2,
  List,
  MoreHorizontal,
  Paintbrush,
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
import { Spinner } from "@/components/ui/spinner";
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
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "violet",
  "pink",
] as const;
const LAYOUT_KEY = "worktrees-layout";
const PULL_REQUEST_FIELDS =
  "id number title url repositoryGithubId repositoryNameWithOwner repositoryUrl labels jiraKey pipelineStatus pipelines { id name status url checkSuiteId canRetry retryUnavailableReason jobs { id name status url canRetry retryUnavailableReason steps { number name status } } } reviewDecision unresolvedReviewThreadCount createdAt";
const WORKTREE_FIELDS = `
  id codebaseId gitDirectory folder relativePath primary branch headSha upstream ahead behind syncState
  baseBranch baseBranchOverride baseAhead baseBehind highlightColor availability statusError
  ticketKey ticketTitle lastCheckedAt missingAt createdAt updatedAt
  tags { id name color createdAt updatedAt }
  activeJob { id agentId kind payload status idempotencyKey result error timeoutSeconds createdAt startedAt finishedAt updatedAt }
  pullRequest { ${PULL_REQUEST_FIELDS} }
`;
const CODEBASE_FIELDS = `
  id folder observedOrigin branch headSha upstream ahead behind syncState availability statusError
  defaultBranch remoteBranches lastCheckedAt lastFetchedAt lastFetchAttemptAt lastFetchError createdAt updatedAt
`;

type Layout = "cards" | "table";
type Operation =
  | "OPEN_EDITOR"
  | "FORCE_PUSH"
  | "SYNC"
  | "PUSH"
  | "RESET"
  | "STASH_ALL"
  | "STAGE_ALL";

async function waitForWorktreeJob(jobId: string): Promise<void> {
  const deadline = new Date().getTime() + 10 * 60_000;
  while (new Date().getTime() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    const data = await controlPlaneRequest<{
      agentJob: { status: string; error: string | null } | null;
    }>("query WorktreeJob($id: ID!) { agentJob(id: $id) { status error } }", {
      id: jobId,
    });
    const job = data.agentJob;
    if (!job || ["QUEUED", "RUNNING"].includes(job.status)) continue;
    if (job.status !== "SUCCEEDED") {
      throw new Error(
        job.error || `Worktree operation ${job.status.toLowerCase()}`,
      );
    }
    return;
  }
  throw new Error(
    "Worktree operation is still running; check the agent job history",
  );
}

const colorClasses: Record<string, string> = {
  gray: "border-slate-500/30 bg-slate-500/10",
  red: "border-red-500/30 bg-red-500/10",
  orange: "border-orange-500/30 bg-orange-500/10",
  amber: "border-amber-500/30 bg-amber-500/10",
  yellow: "border-yellow-500/30 bg-yellow-500/10",
  lime: "border-lime-500/30 bg-lime-500/10",
  green: "border-green-500/30 bg-green-500/10",
  teal: "border-teal-500/30 bg-teal-500/10",
  cyan: "border-cyan-500/30 bg-cyan-500/10",
  blue: "border-blue-500/30 bg-blue-500/10",
  violet: "border-violet-500/30 bg-violet-500/10",
  pink: "border-pink-500/30 bg-pink-500/10",
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
                repository { id canonicalOrigin displayOrigin name description jiraBranchRegex createdAt updatedAt }
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

  const setLayoutAndRemember = (next: Layout) => {
    setLayout(next);
    window.localStorage.setItem(LAYOUT_KEY, next);
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
          <Button disabled={busy} onClick={() => void load()} variant="outline">
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
            key={agentGroup.agent.id}
            layout={layout}
            onError={setError}
            onManageTags={() => setTagManagerOpen(true)}
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
    </section>
  );
}

function AgentSection({
  agentGroup,
  layout,
  allTags,
  editorVariant,
  onReload,
  onUpdate,
  onError,
  onManageTags,
}: {
  agentGroup: WorktreeAgentGroup;
  layout: Layout;
  allTags: WorktreeTag[];
  editorVariant: WorktreeOverview["settings"]["editorVariant"];
  onReload: () => Promise<void>;
  onUpdate: (worktree: Worktree) => void;
  onError: (error: string | null) => void;
  onManageTags: () => void;
}) {
  const t = useTranslations("worktrees");
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
                  editorVariant={editorVariant}
                  group={group}
                  key={worktree.id}
                  onError={onError}
                  onManageTags={onManageTags}
                  onReload={onReload}
                  onUpdate={onUpdate}
                  worktree={worktree}
                />
              ))}
            </div>
          ) : (
            <WorktreeTable
              allTags={allTags}
              editorVariant={editorVariant}
              group={group}
              onError={onError}
              onManageTags={onManageTags}
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
  const { worktree } = props;
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<WorktreeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const t = useTranslations("worktrees");
  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || detail) return;
    setDetailLoading(true);
    try {
      const data = await controlPlaneRequest<{
        inspectWorktree: WorktreeDetail;
      }>(
        `mutation InspectWorktree($id: ID!, $requestId: ID!) {
          inspectWorktree(id: $id, requestId: $requestId) {
            commits { sha subject authorName authoredAt additions deletions }
            changes { path staged unstaged untracked conflicted stagedAdditions stagedDeletions unstagedAdditions unstagedDeletions }
            commitsTruncated changesTruncated
          }
        }`,
        { id: worktree.id, requestId: createClientId() },
      );
      setDetail(data.inspectWorktree);
      props.onError(null);
    } catch (value) {
      props.onError(value instanceof Error ? value.message : String(value));
    } finally {
      setDetailLoading(false);
    }
  };
  return (
    <Card
      className={cn(
        worktree.highlightColor && colorClasses[worktree.highlightColor],
      )}
    >
      <CardHeader className="border-b">
        <CardTitle>
          <Button
            className="h-auto max-w-full justify-start px-0 text-left"
            onClick={() => void toggle()}
            variant="ghost"
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            <span className="truncate font-mono">
              {worktree.branch ??
                worktree.headSha?.slice(0, 10) ??
                t("detached")}
            </span>
            {worktree.primary && <Badge>{t("primary")}</Badge>}
          </Button>
          {(worktree.ticketKey || worktree.ticketTitle) && (
            <p className="mt-1 text-sm font-normal text-muted-foreground">
              {worktree.ticketKey}
              {worktree.ticketTitle ? ` — ${worktree.ticketTitle}` : ""}
            </p>
          )}
        </CardTitle>
        <CardAction>
          <WorktreeMenus {...props} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <WorktreeMetadata {...props} />
        {detailLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("loadingDetails")}
          </p>
        )}
        {expanded && detail && <DetailPanel detail={detail} />}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <ActionRow
          {...props}
          onCompleted={() => {
            setDetail(null);
            return props.onReload();
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
  editorVariant: WorktreeOverview["settings"]["editorVariant"];
  onReload: () => Promise<void>;
  onUpdate: (worktree: Worktree) => void;
  onError: (error: string | null) => void;
  onManageTags: () => void;
};

function WorktreeMetadata(props: WorktreeItemProps) {
  const { worktree, group } = props;
  const t = useTranslations("worktrees");
  return (
    <div className="grid gap-4 text-sm md:grid-cols-2 xl:grid-cols-4">
      <Info label={t("path")} mono value={worktree.relativePath} />
      <BaseBranchControl {...props} />
      <div>
        <p className="text-xs text-muted-foreground">{t("upstreamStatus")}</p>
        <Badge>{syncText(worktree, t)}</Badge>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{t("baseStatus")}</p>
        <Badge
          className={
            worktree.baseBehind === 0
              ? "border-emerald-500/30 bg-emerald-500/10"
              : worktree.baseBehind
                ? "border-amber-500/30 bg-amber-500/10"
                : undefined
          }
        >
          {worktree.baseBehind === null
            ? t("unknown")
            : worktree.baseBehind === 0
              ? t("baseCurrent", { count: worktree.baseAhead ?? 0 })
              : t("baseBehind", { count: worktree.baseBehind })}
        </Badge>
      </div>
      <div className="md:col-span-2 xl:col-span-4 flex flex-wrap items-center gap-2">
        {worktree.tags.map((tag) => (
          <TagBadge key={tag.id} tag={tag} />
        ))}
        {worktree.pullRequest && (
          <>
            <a href={worktree.pullRequest.url} rel="noreferrer" target="_blank">
              <Badge>PR #{worktree.pullRequest.number}</Badge>
            </a>
            <PipelineMenu
              pipelineStatus={worktree.pullRequest.pipelineStatus}
              pipelines={worktree.pullRequest.pipelines}
              repositoryId={worktree.pullRequest.repositoryGithubId}
            />
            <Badge className={reviewClass(worktree.pullRequest.reviewDecision)}>
              {t(`review.${worktree.pullRequest.reviewDecision}`)}
            </Badge>
          </>
        )}
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

function BaseBranchControl(props: WorktreeItemProps) {
  const { worktree, group, onUpdate, onError } = props;
  const t = useTranslations("worktrees");
  const [value, setValue] = useState(worktree.baseBranchOverride ?? "");
  const save = async (next: string) => {
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
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="min-w-0">
      <Label
        className="text-xs text-muted-foreground"
        htmlFor={`base-${worktree.id}`}
      >
        {t("baseBranch")}
      </Label>
      <div className="mt-1 flex gap-1">
        <Input
          id={`base-${worktree.id}`}
          list={`branches-${worktree.id}`}
          onChange={(event) => setValue(event.target.value)}
          placeholder={group.codebase.defaultBranch ?? t("baseUnavailable")}
          value={value}
        />
        <datalist id={`branches-${worktree.id}`}>
          {group.codebase.remoteBranches.map((branch) => (
            <option key={branch} value={branch} />
          ))}
        </datalist>
        <Button
          aria-label={t("saveBase")}
          onClick={() => void save(value)}
          size="icon-sm"
          variant="outline"
        >
          <Save />
        </Button>
        {worktree.baseBranchOverride && (
          <Button
            aria-label={t("inheritBase")}
            onClick={() => {
              setValue("");
              void save("");
            }}
            size="icon-sm"
            variant="ghost"
          >
            <RotateCcw />
          </Button>
        )}
      </div>
    </div>
  );
}

function WorktreeMenus(props: WorktreeItemProps) {
  const { worktree, allTags, onUpdate, onError, onManageTags } = props;
  const t = useTranslations("worktrees");
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={t("customize")} size="icon-sm" variant="ghost">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>
          <Tags /> {t("tags")}
        </DropdownMenuLabel>
        {allTags.map((tag) => (
          <DropdownMenuCheckboxItem
            checked={assigned.has(tag.id)}
            key={tag.id}
            onCheckedChange={(checked) => void assign(tag.id, Boolean(checked))}
          >
            <span
              className={cn(
                "size-3 rounded-full border",
                colorClasses[tag.color],
              )}
            />{" "}
            {tag.name}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuItem onSelect={onManageTags}>
          <Plus /> {t("manageTags")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          <Paintbrush /> {t("highlight")}
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
                colorClasses[color],
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
  );
}

function ActionRow(
  props: WorktreeItemProps & { onCompleted: () => Promise<void> },
) {
  const { worktree, editorVariant } = props;
  const t = useTranslations("worktrees");
  const unavailable =
    worktree.availability !== "AVAILABLE" || Boolean(worktree.activeJob);
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
        disabled={unavailable || !worktree.upstream || !worktree.baseBranch}
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
        disabled={unavailable}
      />
      <OperationButton
        icon={<Check />}
        label={t("stageAll")}
        operation="STAGE_ALL"
        props={props}
        disabled={unavailable}
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
    <div className="grid gap-5 border-t pt-4 xl:grid-cols-2">
      <div>
        <h4 className="mb-2 font-medium">
          {t("commits", { count: detail.commits.length })}
        </h4>
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border">
          {detail.commits.length ? (
            detail.commits.map((commit) => (
              <div
                className="grid grid-cols-[auto_1fr_auto] gap-2 border-b p-2 text-xs last:border-0"
                key={commit.sha}
              >
                <code>{commit.sha.slice(0, 8)}</code>
                <div className="min-w-0">
                  <p className="truncate font-medium">{commit.subject}</p>
                  <p className="text-muted-foreground">
                    {commit.authorName} ·{" "}
                    {new Date(commit.authoredAt).toLocaleString(locale)}
                  </p>
                </div>
                <span>
                  <span className="text-emerald-600">+{commit.additions}</span>{" "}
                  <span className="text-red-600">−{commit.deletions}</span>
                </span>
              </div>
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noCommits")}
            </p>
          )}
        </div>
      </div>
      <div>
        <h4 className="mb-2 font-medium">
          {t("changes", { count: detail.changes.length })}
        </h4>
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border">
          {detail.changes.length ? (
            detail.changes.map((change) => (
              <div
                className="flex items-center gap-2 border-b p-2 text-xs last:border-0"
                key={change.path}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {change.path}
                </span>
                {change.conflicted && <Badge>{t("conflicted")}</Badge>}
                {change.staged && <Badge>{t("staged")}</Badge>}
                {change.unstaged && <Badge>{t("unstaged")}</Badge>}
                {change.untracked && <Badge>{t("untracked")}</Badge>}
                <span className="text-emerald-600">
                  +
                  {(change.stagedAdditions ?? 0) +
                    (change.unstagedAdditions ?? 0)}
                </span>
                <span className="text-red-600">
                  −
                  {(change.stagedDeletions ?? 0) +
                    (change.unstagedDeletions ?? 0)}
                </span>
              </div>
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noChanges")}
            </p>
          )}
        </div>
      </div>
      {(detail.commitsTruncated || detail.changesTruncated) && (
        <p className="text-xs text-muted-foreground xl:col-span-2">
          {t("truncated")}
        </p>
      )}
    </div>
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
            <TableHead>{t("status")}</TableHead>
            <TableHead>{t("tags")}</TableHead>
            <TableHead>{t("pullRequest")}</TableHead>
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
  const { worktree } = props;
  const t = useTranslations("worktrees");
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<WorktreeDetail | null>(null);
  const expand = async () => {
    setExpanded((value) => !value);
    if (detail || expanded) return;
    try {
      const data = await controlPlaneRequest<{
        inspectWorktree: WorktreeDetail;
      }>(
        `mutation InspectWorktree($id: ID!, $requestId: ID!) { inspectWorktree(id: $id, requestId: $requestId) { commits { sha subject authorName authoredAt additions deletions } changes { path staged unstaged untracked conflicted stagedAdditions stagedDeletions unstagedAdditions unstagedDeletions } commitsTruncated changesTruncated } }`,
        { id: worktree.id, requestId: createClientId() },
      );
      setDetail(data.inspectWorktree);
    } catch (value) {
      props.onError(value instanceof Error ? value.message : String(value));
    }
  };
  const highlight =
    worktree.highlightColor && colorClasses[worktree.highlightColor];
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
          {worktree.ticketKey && (
            <p className="text-xs text-muted-foreground">
              {worktree.ticketKey}{" "}
              {worktree.ticketTitle && `— ${worktree.ticketTitle}`}
            </p>
          )}
        </TableCell>
        <TableCell className="font-mono text-xs">
          {worktree.relativePath}
        </TableCell>
        <TableCell>{worktree.baseBranch ?? "—"}</TableCell>
        <TableCell>
          <Badge>{syncText(worktree, t)}</Badge>
        </TableCell>
        <TableCell>
          <div className="flex gap-1">
            {worktree.tags.map((tag) => (
              <TagBadge key={tag.id} tag={tag} />
            ))}
          </div>
        </TableCell>
        <TableCell>
          {worktree.pullRequest ? (
            <a href={worktree.pullRequest.url} rel="noreferrer" target="_blank">
              <Badge>PR #{worktree.pullRequest.number}</Badge>
            </a>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          <WorktreeMenus {...props} />
        </TableCell>
      </TableRow>
      <TableRow className={cn(highlight)}>
        <TableCell colSpan={7}>
          <ActionRow {...props} onCompleted={props.onReload} />
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className={cn(highlight)}>
          <TableCell colSpan={7}>
            {detail ? <DetailPanel detail={detail} /> : <Spinner />}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function TagBadge({ tag }: { tag: WorktreeTag }) {
  return <Badge className={colorClasses[tag.color]}>{tag.name}</Badge>;
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
      <p className={cn("truncate", mono && "font-mono text-xs")} title={value}>
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
                  colorClasses[item],
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
