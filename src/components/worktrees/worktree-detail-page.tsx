"use client";

import {
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_WATCH_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import { ArrowLeft, GitBranch, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Link, useRouter } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { WorktreeDetailPanel } from "./worktree-detail-panel";
import { CODEBASE_FIELDS, WORKTREE_FIELDS } from "./worktree-graphql";
import {
  inspectWorktree,
  useLiveWorktree,
  useQueuedWorktreeInspection,
  useWorktreeActivitySubscription,
  type WorktreeActivity,
} from "./worktree-inspection";
import {
  findWorktreeOverviewEntry,
  worktreeDetailHref,
  type WorktreeOverviewEntry,
} from "./worktree-navigation";
import type { Worktree, WorktreeDetail, WorktreeOverview } from "./types";
import {
  ActionRow,
  BaseFreshnessBadge,
  OriginStatusBadges,
  TagManagerDialog,
  WorktreeMetadata,
  WorktreeMenus,
  WorktreeTicketLink,
  displayedWorktreePath,
  type WorktreeItemProps,
} from "./worktrees-page";

const OVERVIEW_QUERY = `query WorktreeDetailOverview {
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
        repository { id canonicalOrigin displayOrigin name description jiraBranchRegex keepBaseBranchUpToDate createdAt updatedAt }
        codebase { ${CODEBASE_FIELDS} }
        worktrees { ${WORKTREE_FIELDS} }
      }
    }
  }
}`;

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

export function WorktreeDetailPage({ worktreeId }: { worktreeId: string }) {
  const t = useTranslations("worktreeDetail");
  const [overview, setOverview] = useState<WorktreeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestLoad = useRef(0);
  const displayedCodebaseId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const requestId = ++latestLoad.current;
    try {
      const data = await controlPlaneRequest<{
        worktreeOverview: WorktreeOverview;
      }>(OVERVIEW_QUERY);
      if (requestId !== latestLoad.current) return;
      displayedCodebaseId.current =
        findWorktreeOverviewEntry(data.worktreeOverview, worktreeId)?.group
          .codebase.id ?? null;
      setOverview(data.worktreeOverview);
      setError(null);
    } catch (value) {
      if (requestId === latestLoad.current) {
        setError(value instanceof Error ? value.message : String(value));
      }
    } finally {
      if (requestId === latestLoad.current) setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    displayedCodebaseId.current = null;
    const initial = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => void load(), 30_000);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      worktreeOverviewChanged: {
        worktreeId: string | null;
        codebaseId: string | null;
      };
    }>(
      {
        query:
          "subscription WorktreeDetailChanged { worktreeOverviewChanged { worktreeId codebaseId } }",
      },
      {
        next: (value) => {
          const changed = value.data?.worktreeOverviewChanged;
          if (
            !changed ||
            changed.worktreeId === null ||
            changed.worktreeId === worktreeId ||
            (changed.codebaseId !== null &&
              changed.codebaseId === displayedCodebaseId.current)
          ) {
            void load();
          }
        },
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
  }, [load, worktreeId]);

  const entry = useMemo(
    () => (overview ? findWorktreeOverviewEntry(overview, worktreeId) : null),
    [overview, worktreeId],
  );

  const updateWorktree = useCallback((next: Worktree) => {
    setOverview((current) =>
      current
        ? {
            ...current,
            agents: current.agents.map((agentGroup) => ({
              ...agentGroup,
              codebases: agentGroup.codebases.map((group) => ({
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
  }, []);

  if (loading && !overview) {
    return (
      <p className="mx-auto flex max-w-6xl items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }

  if (!overview || !entry) {
    return (
      <section className="mx-auto w-full max-w-6xl space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranch />
            </EmptyMedia>
            <EmptyTitle>{t("notFound")}</EmptyTitle>
            <EmptyDescription>{t("notFoundDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild className="mt-4" variant="outline">
            <Link href="/worktrees">
              <ArrowLeft /> {t("back")}
            </Link>
          </Button>
        </Empty>
      </section>
    );
  }

  return (
    <LoadedWorktreeDetail
      entry={entry}
      key={entry.worktree.id}
      loadError={error}
      onReload={load}
      onUpdate={updateWorktree}
      overview={overview}
    />
  );
}

function LoadedWorktreeDetail({
  entry,
  overview,
  loadError,
  onReload,
  onUpdate,
}: {
  entry: WorktreeOverviewEntry;
  overview: WorktreeOverview;
  loadError: string | null;
  onReload: () => Promise<void>;
  onUpdate: (worktree: Worktree) => void;
}) {
  const t = useTranslations("worktreeDetail");
  const wt = useTranslations("worktrees");
  const locale = useLocale();
  const router = useRouter();
  const [jiraIssueKey, setJiraIssueKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("issue");
  });
  const [detail, setDetail] = useState<WorktreeDetail | null>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const { worktree, applyActivity, setUnstagedChanges } = useLiveWorktree(
    entry.worktree,
  );
  const activeMove = overview.activeMoves.some(
    (move) =>
      move.sourceCodebaseId === entry.group.codebase.id ||
      move.targetCodebaseId === entry.group.codebase.id,
  );
  const canInspect =
    entry.agentGroup.agent.connectionStatus === "ONLINE" &&
    entry.agentGroup.agent.capabilities.includes(WORKTREE_INSPECT_JOB_KIND) &&
    worktree.availability === "AVAILABLE" &&
    !worktree.activeJob &&
    !activeMove;
  const liveUpdatesEnabled =
    entry.agentGroup.agent.connectionStatus === "ONLINE" &&
    entry.agentGroup.agent.capabilities.includes(WORKTREE_WATCH_JOB_KIND);

  const inspect = useCallback(async () => {
    if (!canInspect) return;
    const requestId = ++detailRequest.current;
    setInspectionLoading(true);
    try {
      const next = await inspectWorktree(worktree.id);
      if (requestId !== detailRequest.current) return;
      setDetail(next);
      setUnstagedChanges(
        next.changes.some(
          (change) => change.unstaged || change.untracked || change.conflicted,
        ),
      );
      setOperationError(null);
    } catch (value) {
      if (requestId === detailRequest.current) {
        setOperationError(
          value instanceof Error ? value.message : String(value),
        );
      }
    } finally {
      if (requestId === detailRequest.current) setInspectionLoading(false);
    }
  }, [canInspect, setUnstagedChanges, worktree.id]);
  const refreshInspection = useQueuedWorktreeInspection(inspect);

  useEffect(() => {
    if (!canInspect) return;
    const timer = window.setTimeout(() => void refreshInspection(), 0);
    return () => window.clearTimeout(timer);
  }, [canInspect, refreshInspection]);

  const handleActivity = useCallback(
    (activity: WorktreeActivity) => {
      applyActivity(activity);
      if (canInspect) void refreshInspection();
    },
    [applyActivity, canInspect, refreshInspection],
  );
  useWorktreeActivitySubscription(
    worktree.id,
    liveUpdatesEnabled && worktree.availability === "AVAILABLE",
    handleActivity,
  );

  useEffect(() => {
    const syncIssueFromUrl = () =>
      setJiraIssueKey(new URLSearchParams(window.location.search).get("issue"));
    window.addEventListener("popstate", syncIssueFromUrl);
    return () => window.removeEventListener("popstate", syncIssueFromUrl);
  }, []);

  const openTicket = (issueKey: string | null) => {
    replaceIssueParam(issueKey);
    setJiraIssueKey(issueKey);
  };
  const reloadEverything = useCallback(async () => {
    await onReload();
    if (canInspect) await refreshInspection();
  }, [canInspect, onReload, refreshInspection]);
  const refresh = async () => {
    setOperationBusy(true);
    try {
      await controlPlaneRequest(
        "mutation RefreshWorktrees { refreshWorktrees }",
      );
      await reloadEverything();
      setOperationError(null);
    } catch (value) {
      setOperationError(value instanceof Error ? value.message : String(value));
    } finally {
      setOperationBusy(false);
    }
  };
  const managementProps: WorktreeItemProps = {
    worktree,
    group: entry.group,
    allTags: overview.tags,
    baseRepoDirectory: entry.agentGroup.agent.baseRepoDirectory,
    branchManagementEnabled:
      entry.agentGroup.agent.connectionStatus === "ONLINE" &&
      entry.agentGroup.agent.capabilities.includes("worktree.branch"),
    editorVariant: overview.settings.editorVariant,
    inspectionRefreshToken: 0,
    liveUpdatesEnabled,
    onReload: reloadEverything,
    onUpdate,
    onError: setOperationError,
    onManageTags: () => setTagManagerOpen(true),
    onOpenTicket: (issueKey) => openTicket(issueKey),
    onDeleted: () => router.push("/worktrees"),
    onMoved: (move) => {
      if (move.targetWorktreeId) {
        router.push(worktreeDetailHref(move.targetWorktreeId));
      }
    },
    overview,
  };
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const formatDate = (value: string | null) =>
    value ? dateFormatter.format(new Date(value)) : "—";
  const inspectionUnavailable = !canInspect
    ? entry.agentGroup.agent.connectionStatus === "OFFLINE"
      ? t("inspectionOffline")
      : worktree.availability !== "AVAILABLE"
        ? worktree.statusError || t("inspectionUnavailable")
        : worktree.activeJob || activeMove
          ? t("inspectionBusy")
          : t("inspectionUnsupported")
    : null;

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div>
        <Button asChild className="-ml-2" size="sm" variant="ghost">
          <Link href="/worktrees">
            <ArrowLeft /> {t("back")}
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {entry.group.repository.name} · {entry.agentGroup.agent.name}
          </p>
          <h1 className="mt-1 truncate font-mono text-2xl font-semibold tracking-tight">
            {worktree.branch ??
              worktree.headSha?.slice(0, 10) ??
              wt("detached")}
          </h1>
          <p
            className="mt-1 truncate font-mono text-xs text-muted-foreground"
            title={worktree.folder}
          >
            {displayedWorktreePath(
              worktree.folder,
              entry.agentGroup.agent.baseRepoDirectory,
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {worktree.primary ? wt("primary") : t("linked")}
            </Badge>
            <OriginStatusBadges worktree={worktree} />
            {worktree.hasStagedChanges || worktree.hasUnstagedChanges ? (
              <Badge variant="destructive">{wt("dirty")}</Badge>
            ) : null}
            {worktree.availability !== "AVAILABLE" && (
              <Badge variant="destructive">{worktree.availability}</Badge>
            )}
          </div>
          {(worktree.ticketKey || worktree.ticketTitle) && (
            <WorktreeTicketLink {...managementProps} />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={operationBusy}
            onClick={() => void refresh()}
            variant="outline"
          >
            <RefreshCw className={operationBusy ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          <WorktreeMenus {...managementProps} />
        </div>
      </div>

      {(loadError || operationError || worktree.statusError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {operationError || loadError || worktree.statusError}
          </AlertDescription>
        </Alert>
      )}
      {inspectionUnavailable && (
        <Alert>
          <AlertDescription>{inspectionUnavailable}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("actions")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionRow {...managementProps} onCompleted={reloadEverything} />
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <Card className="min-w-0">
          <CardHeader className="border-b">
            <CardTitle>{t("workingTree")}</CardTitle>
          </CardHeader>
          <CardContent>
            {inspectionLoading && !detail ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> {wt("loadingDetails")}
              </p>
            ) : detail ? (
              <WorktreeDetailPanel detail={detail} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {canInspect ? t("inspectionFailed") : "—"}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>{t("overview")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                <DetailValue label={t("repository")}>
                  <Link
                    className="text-primary hover:underline"
                    href={`/codebases/${entry.group.codebase.id}`}
                  >
                    {entry.group.repository.name}
                  </Link>
                </DetailValue>
                <DetailValue label={t("origin")} mono>
                  {entry.group.repository.displayOrigin}
                </DetailValue>
                <DetailValue label={t("agent")}>
                  {entry.agentGroup.agent.name} ·{" "}
                  {entry.agentGroup.agent.hostname}
                </DetailValue>
                <DetailValue label={t("folder")} mono>
                  {worktree.folder}
                </DetailValue>
                <DetailValue label={t("head")} mono>
                  {worktree.headSha ?? "—"}
                </DetailValue>
                <DetailValue label={t("upstream")} mono>
                  {worktree.upstream ?? "—"}
                </DetailValue>
                <DetailValue label={t("originStatus")}>
                  <OriginStatusBadges worktree={worktree} />
                </DetailValue>
                <DetailValue label={t("baseStatus")}>
                  <BaseFreshnessBadge worktree={worktree} />
                </DetailValue>
                <DetailValue label={t("lastChecked")}>
                  {formatDate(worktree.lastCheckedAt)}
                </DetailValue>
                <DetailValue label={t("lastFetched")}>
                  {formatDate(entry.group.codebase.lastFetchedAt)}
                </DetailValue>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>{t("management")}</CardTitle>
            </CardHeader>
            <CardContent>
              <WorktreeMetadata {...managementProps} />
            </CardContent>
          </Card>
        </div>
      </div>

      <JiraTicketDrawer
        issueKey={jiraIssueKey}
        onClose={() => openTicket(null)}
      />
      <TagManagerDialog
        onChanged={onReload}
        onOpenChange={setTagManagerOpen}
        open={tagManagerOpen}
        tags={overview.tags}
      />
    </section>
  );
}

function DetailValue({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 break-all font-mono text-xs" : "mt-0.5"}>
        {children}
      </dd>
    </div>
  );
}
