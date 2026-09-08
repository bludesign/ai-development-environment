"use client";

import { readWorktreeBuildWindow } from "@/components/builds/build-history-window";

import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BUILD_LIST_FIELDS } from "@/components/builds/graphql-fields";
import type { BuildRecord } from "@/components/builds/types";
import { CommandQuickActions } from "@/components/commands/command-quick-actions";
import { DetailItem, DetailList } from "@/components/common/detail-list";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkflowQuickActions } from "@/components/workflows/workflow-quick-actions";
import {
  WORKTREE_DETAIL_OVERVIEW_QUERY,
  WorktreeBuildTable,
} from "@/components/worktrees/worktree-detail-page";
import {
  findWorktreeOverviewEntry,
  worktreeDetailHref,
} from "@/components/worktrees/worktree-navigation";
import type { WorktreeOverview } from "@/components/worktrees/types";
import {
  BaseFreshnessBadge,
  OriginStatusBadges,
  PrimaryWorktreeActions,
  PullRequestBadges,
  displayedWorktreePath,
} from "@/components/worktrees/worktrees-page";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

const INITIAL_BUILD_PAGE_SIZE = 50;

export function RunWorktreeCards({ worktreeId }: { worktreeId: string }) {
  const t = useTranslations("runs");
  const wt = useTranslations("worktrees");
  const detailT = useTranslations("worktreeDetail");
  const [overview, setOverview] = useState<WorktreeOverview | null>(null);
  const [builds, setBuilds] = useState<BuildRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedBuildCount = useRef(INITIAL_BUILD_PAGE_SIZE);
  const buildPagination = useRef<AbortController | null>(null);

  const overviewOwner = useRef<RefreshCoalescer | null>(null);
  const load = useCallback(
    () => overviewOwner.current?.refresh() ?? Promise.resolve(),
    [],
  );
  const fetchOverview = useCallback(
    async (signal: AbortSignal) => {
      buildPagination.current?.abort();
      buildPagination.current = null;
      setLoadingMore(false);
      try {
        const data = await controlPlaneRequest<{
          worktreeOverview: WorktreeOverview;
          builds: { items: BuildRecord[]; nextCursor: string | null };
        }>(
          WORKTREE_DETAIL_OVERVIEW_QUERY,
          {
            worktreeId,
            buildFirst: Math.min(200, loadedBuildCount.current),
            includeCoverage: false,
            includeQueue: false,
          },
          { signal },
        );
        if (signal.aborted) return;
        const history = await readWorktreeBuildWindow(
          worktreeId,
          data.builds ?? { items: [], nextCursor: null },
          loadedBuildCount.current,
          signal,
        );
        if (signal.aborted) return;
        setOverview(data.worktreeOverview);
        setBuilds(history.items);
        setNextCursor(history.nextCursor);
        setError(null);
      } catch (value) {
        if (signal.aborted) return;
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [worktreeId],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || buildPagination.current) return;
    const controller = new AbortController();
    buildPagination.current = controller;
    setLoadingMore(true);
    try {
      const data = await controlPlaneRequest<{
        builds: { items: BuildRecord[]; nextCursor: string | null };
      }>(
        `query RunWorktreeBuilds($worktreeId: ID!, $after: ID!) {
          builds(first: 50, after: $after, worktreeId: $worktreeId) {
            items { ${BUILD_LIST_FIELDS} }
            nextCursor
          }
        }`,
        { worktreeId, after: nextCursor },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setBuilds((current) => {
        const ids = new Set(current.map((build) => build.id));
        const merged = [
          ...current,
          ...data.builds.items.filter((build) => !ids.has(build.id)),
        ];
        loadedBuildCount.current = Math.max(
          INITIAL_BUILD_PAGE_SIZE,
          merged.length,
        );
        return merged;
      });
      setNextCursor(data.builds.nextCursor);
      setError(null);
    } catch (value) {
      if (controller.signal.aborted) return;
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (buildPagination.current === controller)
        buildPagination.current = null;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [nextCursor, worktreeId]);

  useEffect(() => {
    loadedBuildCount.current = 50;
    const owner = createRefreshCoalescer(fetchOverview);
    overviewOwner.current = owner;
    const recovery = onControlPlaneRecovery(() => void owner.refresh());
    return () => {
      owner.dispose();
      recovery();
      buildPagination.current?.abort();
      buildPagination.current = null;
      if (overviewOwner.current === owner) overviewOwner.current = null;
    };
  }, [fetchOverview]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => void load(), 30_000);
    const subscriptions = controlPlaneSubscriptions();
    const unsubscribeWorktrees = subscriptions.subscribe<{
      worktreeOverviewChanged: { worktreeId: string | null } | null;
    }>(
      {
        query:
          "subscription RunWorktreeChanged { worktreeOverviewChanged { worktreeId } }",
      },
      {
        next: (value) => {
          const changed = value.data?.worktreeOverviewChanged;
          if (
            !changed ||
            !changed.worktreeId ||
            changed.worktreeId === worktreeId
          ) {
            void load();
          }
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const unsubscribeBuilds = subscriptions.subscribe(
      {
        query:
          "subscription RunWorktreeBuildsChanged($worktreeId: ID!) { buildsChanged(worktreeId: $worktreeId) { id } }",
        variables: { worktreeId },
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
      unsubscribeWorktrees();
      unsubscribeBuilds();
    };
  }, [load, worktreeId]);

  const entry = useMemo(
    () => (overview ? findWorktreeOverviewEntry(overview, worktreeId) : null),
    [overview, worktreeId],
  );

  if (loading && !entry) return null;
  if (!entry) {
    return error ? (
      <Alert>
        <AlertDescription>{t("worktreeDataUnavailable")}</AlertDescription>
      </Alert>
    ) : null;
  }

  const { agentGroup, group, worktree } = entry;
  const clean = !worktree.hasStagedChanges && !worktree.hasUnstagedChanges;
  const refresh = async () => void (await load());

  return (
    <>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{detailT("actions")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <PrimaryWorktreeActions
            group={group}
            onCompleted={refresh}
            overview={overview!}
            worktree={worktree}
          />
          <WorkflowQuickActions
            sessionData={{
              worktree: {
                id: worktree.id,
                path: worktree.folder,
                branch: worktree.branch,
                baseBranch: worktree.baseBranch,
                headSha: worktree.headSha,
              },
              codebase: {
                id: group.codebase.id,
                folder: group.codebase.folder,
              },
              repo: {
                id: group.repository.id,
                name: group.repository.name,
                url: group.repository.displayOrigin,
                displayOrigin: group.repository.displayOrigin,
              },
            }}
            workflows={group.quickActions ?? []}
            worktreeId={worktree.id}
          />
          <CommandQuickActions
            agentCapabilities={agentGroup.agent.capabilities}
            worktreeId={worktree.id}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>{t("worktreeStatus")}</CardTitle>
          <Button asChild size="sm" variant="outline">
            <Link href={worktreeDetailHref(worktree.id)}>
              <ExternalLink /> {t("openWorktree")}
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={clean ? "secondary" : "destructive"}>
              {clean ? wt("clean") : wt("dirty")}
            </Badge>
            <OriginStatusBadges worktree={worktree} />
            <Badge
              variant={
                worktree.availability === "AVAILABLE"
                  ? "outline"
                  : "destructive"
              }
            >
              {worktree.availability}
            </Badge>
          </div>
          <DetailList className="grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            <DetailItem label={wt("branch")} mono>
              {worktree.branch ?? wt("detached")}
            </DetailItem>
            <DetailItem label={wt("baseBranch")} mono>
              {worktree.baseBranchOverride ?? worktree.baseBranch ?? "—"}
            </DetailItem>
            <DetailItem label={wt("path")} mono>
              {displayedWorktreePath(
                worktree.folder,
                agentGroup.agent.baseRepoDirectory,
              )}
            </DetailItem>
            <DetailItem label={detailT("upstream")} mono>
              {worktree.upstream ?? "—"}
            </DetailItem>
            <DetailItem label={detailT("head")} mono>
              {worktree.headSha ?? "—"}
            </DetailItem>
            <DetailItem label={detailT("agent")}>
              {agentGroup.agent.name} · {agentGroup.agent.hostname}
            </DetailItem>
            <DetailItem label={detailT("baseStatus")}>
              <BaseFreshnessBadge worktree={worktree} />
            </DetailItem>
            <DetailItem className="md:col-span-2" label={wt("pullRequest")}>
              <span className="flex flex-wrap items-center gap-2">
                <PullRequestBadges worktree={worktree} />
              </span>
            </DetailItem>
          </DetailList>
        </CardContent>
      </Card>

      <WorktreeBuildTable
        builds={builds}
        loadingMore={loadingMore}
        nextCursor={nextCursor}
        onError={setError}
        onLoadMore={loadMore}
        onReload={refresh}
      />
    </>
  );
}
