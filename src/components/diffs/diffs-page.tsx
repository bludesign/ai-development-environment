"use client";

import { useEffect, useMemo, useState } from "react";
import { PanelLeft, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

import { SearchableSelect } from "@/components/common/searchable-select";
import type { DiffViewMode } from "@/components/common/diff-view";
// `useSearchParams` is deliberately not used: this is a static route, and
// calling it from a client component here fails the production build without a
// Suspense boundary. The route reads the query string on the server instead.
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WorktreeDetail } from "@/components/worktrees/types";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CommitPicker } from "./commit-picker";
import { CoveragePicker, NO_COVERAGE_REPORT } from "./coverage-picker";
import { DiffFileList } from "./diff-file-list";
import { DiffPane } from "./diff-pane";
import {
  DIFF_WORKTREES_QUERY,
  DIFF_WORKTREE_DETAIL_MUTATION,
  INSPECT_WORKTREE_DIFF_MUTATION,
} from "./diffs-graphql";
import type { DiffFileEntry, DiffScope, DiffWorktreeOption } from "./types";
import { useCoverageReport, useCoverageReports } from "./use-coverage-report";

const SCOPES: DiffScope[] = [
  "STAGED",
  "UNSTAGED",
  "UNTRACKED",
  "BRANCH",
  "COMMIT",
];

type OverviewResponse = {
  worktreeOverview: {
    agents: Array<{
      codebases: Array<{
        repository: { id: string; name: string; displayOrigin: string } | null;
        codebase: { id: string; folder: string; defaultBranch: string | null };
        worktrees: Array<{
          id: string;
          branch: string;
          relativePath: string;
          folder: string;
          headSha: string | null;
          codeStateHash: string | null;
          baseBranch: string | null;
          availability: string;
          pullRequest: DiffWorktreeOption["pullRequest"];
        }>;
      }>;
    }>;
  };
};

function flattenWorktrees(data: OverviewResponse): DiffWorktreeOption[] {
  return data.worktreeOverview.agents.flatMap((agent) =>
    agent.codebases.flatMap((entry) =>
      entry.worktrees.map((worktree) => ({
        ...worktree,
        codebaseName:
          entry.repository?.name ??
          entry.codebase.folder.split("/").at(-1) ??
          entry.codebase.folder,
      })),
    ),
  );
}

/** Rebuilds the file list for a scope from whichever source that scope uses. */
function filesForScope(
  scope: DiffScope,
  detail: WorktreeDetail | null,
  branchFiles: DiffFileEntry[],
  commitFiles: DiffFileEntry[],
): DiffFileEntry[] {
  if (scope === "BRANCH") return branchFiles;
  if (scope === "COMMIT") return commitFiles;
  if (!detail) return [];
  return detail.changes
    .filter((change) =>
      scope === "STAGED"
        ? change.staged
        : scope === "UNSTAGED"
          ? change.unstaged
          : change.untracked,
    )
    .map((change) => ({
      key: `${change.previousPath ?? ""}:${change.path}`,
      path: change.path,
      previousPath: change.previousPath ?? null,
      changeType: change.changeType ?? "M",
      additions:
        scope === "STAGED" ? change.stagedAdditions : change.unstagedAdditions,
      deletions:
        scope === "STAGED" ? change.stagedDeletions : change.unstagedDeletions,
      binary: false,
      image: false,
      lineCoverage: null,
      module: null,
    }));
}

function revisionsDiffer(
  measured: string | null | undefined,
  displayed: string | null | undefined,
): boolean {
  return Boolean(measured && displayed && measured !== displayed);
}

/** Initial selection, parsed from the query string by the route. */
export type DiffsPageInitialState = {
  worktreeId?: string;
  scope?: string;
  path?: string;
  commitSha?: string;
  coverageReportId?: string;
  mode?: string;
  wrap?: string;
};

export function DiffsPage({
  initial = {},
}: {
  initial?: DiffsPageInitialState;
}) {
  const t = useTranslations("diffs");

  const [worktrees, setWorktrees] = useState<DiffWorktreeOption[]>([]);
  const [worktreeId, setWorktreeId] = useState(initial.worktreeId ?? "");
  const [scope, setScope] = useState<DiffScope>(() =>
    SCOPES.includes(initial.scope as DiffScope)
      ? (initial.scope as DiffScope)
      : "BRANCH",
  );
  const [mode, setMode] = useState<DiffViewMode>(
    initial.mode === "SPLIT" ? "SPLIT" : "UNIFIED",
  );
  // Wrapping is the default, so the query string carries the opt-out. An older
  // link saying `wrap=1` still lands on wrapped.
  const [wrap, setWrap] = useState(initial.wrap !== "0");
  const [selectedPath, setSelectedPath] = useState(initial.path ?? "");
  const [commitSha, setCommitSha] = useState(initial.commitSha ?? "");
  const [coverageReportId, setCoverageReportId] = useState(
    initial.coverageReportId ?? "",
  );

  // Tag detail data with its checkout. Changing the selection hides the old
  // list immediately, before the next effect has a chance to start loading.
  const [loadedDetail, setLoadedDetail] = useState<{
    worktreeId: string;
    detail: WorktreeDetail | null;
    branchFiles: DiffFileEntry[];
  } | null>(null);
  // Tagged with the checkout and commit it describes so a stale list is
  // discarded by derivation rather than by resetting state from an effect.
  const [commitDiff, setCommitDiff] = useState<{
    worktreeId: string;
    sha: string;
    files: DiffFileEntry[];
    truncated: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);

  const worktree = worktrees.find((entry) => entry.id === worktreeId) ?? null;
  const detail =
    loadedDetail?.worktreeId === worktreeId ? loadedDetail.detail : null;
  const branchFiles =
    loadedDetail?.worktreeId === worktreeId ? loadedDetail.branchFiles : [];

  const coverageReports = useCoverageReports(worktreeId);
  const coverageReport =
    coverageReports.find((entry) => entry.id === coverageReportId) ?? null;
  const { files: coverageFiles, loading: coverageLoading } = useCoverageReport(
    coverageReport,
    worktree?.folder ?? null,
  );
  // The overlay describes the revision the build measured. When the worktree has
  // moved on, line numbers can no longer be trusted to line up, so the strip is
  // dimmed rather than hidden — a stale reading still beats none.
  const coverageStale = Boolean(
    coverageReport &&
    (scope === "COMMIT"
      ? revisionsDiffer(coverageReport.headSha, commitSha)
      : scope === "BRANCH"
        ? revisionsDiffer(coverageReport.headSha, worktree?.headSha)
        : coverageReport.codeStateHash || worktree?.codeStateHash
          ? !coverageReport.codeStateHash ||
            !worktree?.codeStateHash ||
            revisionsDiffer(
              coverageReport.codeStateHash,
              worktree.codeStateHash,
            )
          : revisionsDiffer(coverageReport.headSha, worktree?.headSha)),
  );

  useEffect(() => {
    let disposed = false;
    void controlPlaneRequest<OverviewResponse>(DIFF_WORKTREES_QUERY)
      .then((data) => {
        if (disposed) return;
        const list = flattenWorktrees(data);
        setWorktrees(list);
        // Default to the first worktree so the page is never empty on arrival.
        setWorktreeId((current) =>
          current || !list.length ? current : list[0]!.id,
        );
      })
      .catch((reason) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    // Deferred so the synchronous effect body does not set state directly.
    if (!worktreeId) return;
    let disposed = false;
    const requestedWorktreeId = worktreeId;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void controlPlaneRequest<{
        inspectWorktree: WorktreeDetail;
      }>(DIFF_WORKTREE_DETAIL_MUTATION, {
        id: requestedWorktreeId,
        requestId: createClientId(),
      })
        .then((data) => {
          if (disposed) return;
          setLoadedDetail({
            worktreeId: requestedWorktreeId,
            detail: data.inspectWorktree,
            branchFiles: (data.inspectWorktree.branchChanges ?? []).map(
              (file) => ({
                ...file,
                key: `${file.previousPath ?? ""}:${file.path}`,
                lineCoverage: null,
                module: null,
              }),
            ),
          });
        })
        .catch((reason) => {
          if (disposed) return;
          setLoadedDetail({
            worktreeId: requestedWorktreeId,
            detail: null,
            branchFiles: [],
          });
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }, 0);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refreshToken, worktreeId]);

  // The commit scope needs its own file list, fetched per selected commit.
  useEffect(() => {
    if (scope !== "COMMIT" || !worktreeId || !commitSha) return;
    let disposed = false;
    void controlPlaneRequest<{
      inspectWorktreeDiff: { files: DiffFileEntry[]; truncated: boolean };
    }>(INSPECT_WORKTREE_DIFF_MUTATION, {
      input: {
        worktreeId,
        scope: "COMMIT",
        path: null,
        previousPath: null,
        commitSha,
        requestId: createClientId(),
      },
    })
      .then((data) => {
        if (disposed) return;
        setCommitDiff({
          worktreeId,
          sha: commitSha,
          truncated: data.inspectWorktreeDiff.truncated,
          files: data.inspectWorktreeDiff.files.map((file) => ({
            ...file,
            key: `${file.previousPath ?? ""}:${file.path}`,
            lineCoverage: null,
            module: null,
          })),
        });
      })
      .catch((reason) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [commitSha, scope, worktreeId, refreshToken]);

  const commitFiles =
    commitDiff &&
    commitDiff.worktreeId === worktreeId &&
    commitDiff.sha === commitSha
      ? commitDiff.files
      : [];
  const commitFilesTruncated = Boolean(
    commitDiff &&
    commitDiff.worktreeId === worktreeId &&
    commitDiff.sha === commitSha &&
    commitDiff.truncated,
  );
  const files = useMemo(() => {
    const scoped = filesForScope(scope, detail, branchFiles, commitFiles);
    if (!coverageFiles.size) return scoped;
    return scoped.map((file) => {
      const entry = coverageFiles.get(file.path);
      return entry
        ? { ...file, lineCoverage: entry.lineCoverage, module: entry.module }
        : file;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchFiles, commitDiff, commitSha, coverageFiles, detail, scope]);
  const selected =
    files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  // Resolved against the new revision, which is what the diff's `newLine`
  // numbers count in. Files the report never measured get no lookup at all, so
  // the strip stays blank rather than claiming everything is uncovered.
  const coverage = useMemo(() => {
    const entry = selected ? coverageFiles.get(selected.path) : undefined;
    if (!entry || (!entry.covered.size && !entry.uncovered.size)) {
      return undefined;
    }
    return (newLine: number): "covered" | "uncovered" | null =>
      entry.covered.has(newLine)
        ? "covered"
        : entry.uncovered.has(newLine)
          ? "uncovered"
          : null;
  }, [coverageFiles, selected]);

  // Keep the URL in step so a diff view is linkable and survives reload.
  useEffect(() => {
    const params = new URLSearchParams();
    if (worktreeId) params.set("worktree", worktreeId);
    params.set("scope", scope);
    if (selected) params.set("path", selected.path);
    if (scope === "COMMIT" && commitSha) params.set("commit", commitSha);
    if (coverageReportId) params.set("coverage", coverageReportId);
    if (mode === "SPLIT") params.set("mode", mode);
    if (!wrap) params.set("wrap", "0");
    window.history.replaceState(null, "", `${location.pathname}?${params}`);
  }, [commitSha, coverageReportId, mode, scope, selected, worktreeId, wrap]);

  const sidebar = (
    <div className="flex min-h-0 flex-col gap-3">
      {scope === "COMMIT" && (
        <CommitPicker
          commits={detail?.commits ?? []}
          onSelect={(sha) => {
            setCommitSha(sha);
            setSelectedPath("");
          }}
          selectedSha={commitSha || null}
          truncated={detail?.commitsTruncated ?? false}
        />
      )}
      <DiffFileList
        files={files}
        onSelect={(file) => {
          setSelectedPath(file.path);
          setSheetOpen(false);
        }}
        selectedKey={selected?.key ?? null}
        showCoverage={Boolean(coverageReport)}
        truncated={
          scope === "BRANCH"
            ? (detail?.branchChangesTruncated ?? false)
            : scope === "COMMIT"
              ? commitFilesTruncated
              : (detail?.changesTruncated ?? false)
        }
      />
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CoveragePicker
            loading={coverageLoading}
            onSelect={(value) =>
              setCoverageReportId(value === NO_COVERAGE_REPORT ? "" : value)
            }
            reports={coverageReports}
            selectedId={coverageReportId}
            stale={coverageStale}
          />
          <SearchableSelect
            ariaLabel={t("selectWorktree")}
            className="w-72"
            emptyMessage={t("noWorktrees")}
            onValueChange={(value) => {
              setWorktreeId(value);
              setSelectedPath("");
              setCommitSha("");
            }}
            options={worktrees.map((entry) => ({
              value: entry.id,
              label: entry.branch,
              description: entry.codebaseName,
              secondaryDescription: entry.relativePath,
              keywords: `${entry.relativePath} ${entry.folder}`,
            }))}
            placeholder={t("selectWorktree")}
            searchPlaceholder={t("searchWorktrees")}
            value={worktreeId}
          />
          <Button
            aria-label={t("refresh")}
            disabled={!worktreeId || loading}
            onClick={() => setRefreshToken(createClientId())}
            size="icon"
            title={t("refresh")}
            variant="outline"
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs
        onValueChange={(value) => setScope(value as DiffScope)}
        value={scope}
      >
        <TabsList>
          {SCOPES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`scope.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {!worktreeId ? (
        <p className="text-sm text-muted-foreground">{t("selectAWorktree")}</p>
      ) : loading && !detail ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
          {/* The shell's <main> already scrolls; only the file list gets its
              own scroll so the diff keeps find-in-page and anchor scrolling. */}
          <aside className="sticky top-0 hidden max-h-[calc(100dvh-10rem)] min-h-0 md:flex md:flex-col">
            {sidebar}
          </aside>
          <div className="md:hidden">
            <Sheet onOpenChange={setSheetOpen} open={sheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline">
                  <PanelLeft className="size-4" /> {t("files")}
                </Button>
              </SheetTrigger>
              <SheetContent
                className="flex w-[min(22rem,90vw)] flex-col gap-3 p-4"
                side="left"
              >
                <SheetHeader className="p-0">
                  <SheetTitle>{t("files")}</SheetTitle>
                </SheetHeader>
                {sidebar}
              </SheetContent>
            </Sheet>
          </div>
          <DiffPane
            commitSha={scope === "COMMIT" ? commitSha || null : null}
            coverage={coverage}
            coverageStale={coverageStale}
            file={selected}
            mode={mode}
            onModeChange={setMode}
            onWrapChange={setWrap}
            resetToken={`${worktreeId}:${refreshToken}`}
            scope={scope}
            worktreeId={worktreeId}
            wrap={wrap}
          />
        </div>
      )}
      {worktree?.pullRequest && (
        <p className="text-xs text-muted-foreground">
          {t("linkedPullRequest", {
            number: worktree.pullRequest.number,
            title: worktree.pullRequest.title,
          })}
        </p>
      )}
    </div>
  );
}
