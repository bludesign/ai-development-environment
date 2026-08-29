"use client";

import { ChevronDown, FileCode2, Images } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { DateTime } from "@/components/common/date-time";
import {
  ImageDiff,
  PatchDiffView,
  useDiffViewLabels,
  useImageDiffLabels,
} from "@/components/common/diff-view";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { INSPECT_WORKTREE_DIFF_MUTATION } from "./worktree-graphql";
import type {
  WorktreeDetail,
  WorktreeDiffFile,
  WorktreeFileDiff,
} from "./types";

type DiffScope = "STAGED" | "UNSTAGED" | "UNTRACKED" | "COMMIT" | "BRANCH";

export function WorktreeDetailPanel({
  detail,
  worktreeId,
  inline = false,
}: {
  detail: WorktreeDetail;
  worktreeId: string;
  inline?: boolean;
}) {
  const t = useTranslations("worktrees");
  if (inline)
    return <InlineWorktreeDetail detail={detail} worktreeId={worktreeId} />;
  return (
    <div
      className={cn("w-full space-y-4", inline && "border-t pt-4")}
      data-testid="worktree-detail"
      data-worktree-navigation-ignore={inline ? "true" : undefined}
    >
      <section>
        <h2 className="mb-2 font-medium">
          {t("changes", { count: detail.changes.length })}
        </h2>
        <div className="divide-y rounded-md border">
          {detail.changes.length ? (
            detail.changes.map((change) => (
              <WorktreeChangeRow
                change={change}
                key={change.path}
                worktreeId={worktreeId}
              />
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noChanges")}
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-medium">
          {t("commits", { count: detail.commits.length })}
        </h2>
        <div className="divide-y rounded-md border">
          {detail.commits.length ? (
            detail.commits.map((commit) => (
              <ExpandableRow
                key={commit.sha}
                label={commit.subject}
                prefix={commit.sha.slice(0, 8)}
                summary={
                  <span className="text-xs text-muted-foreground">
                    {commit.authorName} · <DateTime value={commit.authoredAt} />{" "}
                    ·{" "}
                    <LineCounts
                      additions={commit.additions}
                      deletions={commit.deletions}
                    />
                  </span>
                }
              >
                {worktreeId ? (
                  <CommitFiles commitSha={commit.sha} worktreeId={worktreeId} />
                ) : null}
              </ExpandableRow>
            ))
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

function InlineWorktreeDetail({
  detail,
  worktreeId,
}: {
  detail: WorktreeDetail;
  worktreeId: string;
}) {
  const t = useTranslations("worktrees");
  return (
    <div
      className="w-full space-y-4 border-t pt-4"
      data-testid="worktree-detail"
      data-worktree-navigation-ignore="true"
    >
      <section>
        <h2 className="mb-2 font-medium">
          {t("changes", { count: detail.changes.length })}
        </h2>
        <div
          aria-label={t("changes", { count: detail.changes.length })}
          className="max-h-80 divide-y overflow-auto rounded-md border"
          role="group"
        >
          {detail.changes.length ? (
            detail.changes.map((change) => (
              <WorktreeChangeRow
                change={change}
                key={change.path}
                worktreeId={worktreeId}
              />
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t("noChanges")}
            </p>
          )}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-medium">
          {t("commits", { count: detail.commits.length })}
        </h2>
        <div className="max-h-80 overflow-auto rounded-md border">
          {detail.commits.length ? (
            <Table
              aria-label={t("commits", { count: detail.commits.length })}
              className="min-w-[36rem] table-fixed text-xs"
            >
              <TableBody>
                {detail.commits.map((commit) => (
                  <TableRow key={commit.sha}>
                    <TableCell className="w-24 px-2 py-1.5 font-mono text-muted-foreground">
                      {commit.sha.slice(0, 8)}
                    </TableCell>
                    <TableCell className="max-w-0 px-2 py-1.5">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 flex-1 break-words whitespace-normal font-medium">
                          {commit.subject}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {commit.authorName} ·{" "}
                          <DateTime value={commit.authoredAt} />
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
    </div>
  );
}

function WorktreeChangeRow({
  change,
  worktreeId,
}: {
  change: WorktreeDetail["changes"][number];
  worktreeId: string;
}) {
  const t = useTranslations("worktrees");
  return (
    <ExpandableRow
      label={change.path}
      summary={
        <div className="flex flex-wrap items-center gap-2">
          {change.conflicted && (
            <Badge variant="destructive">{t("conflicted")}</Badge>
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
      }
    >
      <div className="space-y-3">
        {change.staged && (
          <DiffBlock
            label={t("staged")}
            path={change.path}
            previousPath={change.previousPath}
            scope="STAGED"
            worktreeId={worktreeId}
          />
        )}
        {change.unstaged && (
          <DiffBlock
            label={t("unstaged")}
            path={change.path}
            scope="UNSTAGED"
            worktreeId={worktreeId}
          />
        )}
        {change.untracked && (
          <DiffBlock
            label={t("untracked")}
            path={change.path}
            scope="UNTRACKED"
            worktreeId={worktreeId}
          />
        )}
      </div>
    </ExpandableRow>
  );
}

export function BranchChangesPanel({
  files,
  truncated,
  worktreeId,
}: {
  files: WorktreeDiffFile[];
  truncated: boolean;
  worktreeId: string;
}) {
  const t = useTranslations("worktreeDetail");
  return (
    <div className="space-y-3">
      {files.length ? (
        <div className="divide-y rounded-md border">
          {files.map((file) => (
            <ExpandableDiffFile
              file={file}
              key={`${file.previousPath ?? ""}:${file.path}`}
              scope="BRANCH"
              worktreeId={worktreeId}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("noBranchChanges")}</p>
      )}
      {truncated && (
        <p className="text-xs text-muted-foreground">{t("diffTruncated")}</p>
      )}
    </div>
  );
}

function ExpandableRow({
  label,
  prefix,
  summary,
  children,
}: {
  label: string;
  prefix?: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        aria-expanded={open}
        className="flex min-h-8 w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
        {prefix && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {prefix}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={label}
        >
          {label}
        </span>
        <span className="shrink-0">{summary}</span>
      </button>
      {open && children && (
        <div className="border-t bg-muted/10 p-3">{children}</div>
      )}
    </div>
  );
}

function CommitFiles({
  worktreeId,
  commitSha,
}: {
  worktreeId: string;
  commitSha: string;
}) {
  const { value, loading, error } = useDiff(
    worktreeId,
    "COMMIT",
    null,
    null,
    commitSha,
  );
  if (loading) return <LoadingDiff />;
  if (error) return <DiffError value={error} />;
  return (
    <div className="divide-y rounded-md border bg-background">
      {value?.files.map((file) => (
        <ExpandableDiffFile
          commitSha={commitSha}
          file={file}
          key={`${file.previousPath ?? ""}:${file.path}`}
          scope="COMMIT"
          worktreeId={worktreeId}
        />
      ))}
    </div>
  );
}

function ExpandableDiffFile({
  file,
  worktreeId,
  scope,
  commitSha,
}: {
  file: WorktreeDiffFile;
  worktreeId: string;
  scope: DiffScope;
  commitSha?: string;
}) {
  return (
    <ExpandableRow
      label={file.path}
      summary={
        <span className="inline-flex items-center gap-2">
          {file.image ? (
            <Images className="size-4" />
          ) : (
            <FileCode2 className="size-4" />
          )}
          <Badge variant="outline">{file.changeType}</Badge>
          <LineCounts additions={file.additions} deletions={file.deletions} />
        </span>
      }
    >
      <DiffBlock
        commitSha={commitSha}
        path={file.path}
        previousPath={file.previousPath}
        scope={scope}
        worktreeId={worktreeId}
      />
    </ExpandableRow>
  );
}

function DiffBlock({
  label,
  worktreeId,
  path,
  previousPath,
  scope,
  commitSha,
}: {
  label?: string;
  worktreeId: string;
  path: string;
  previousPath?: string | null;
  scope: DiffScope;
  commitSha?: string;
}) {
  const t = useTranslations("worktreeDetail");
  const diffLabels = useDiffViewLabels();
  const imageLabels = useImageDiffLabels();
  const { value, loading, error } = useDiff(
    worktreeId,
    scope,
    path,
    previousPath ?? null,
    commitSha ?? null,
  );
  const imageUrl = (side: "AFTER" | "BEFORE") => {
    const params = new URLSearchParams({ scope, path, side });
    if (previousPath) params.set("previousPath", previousPath);
    if (commitSha) params.set("commitSha", commitSha);
    return `/api/worktrees/${encodeURIComponent(worktreeId)}/diff-image?${params}`;
  };
  return (
    <div className="space-y-2">
      {label && (
        <p className="text-xs font-medium uppercase text-muted-foreground">
          {label}
        </p>
      )}
      {loading ? (
        <LoadingDiff />
      ) : error ? (
        <DiffError value={error} />
      ) : value?.image ? (
        <ImageDiff
          after={value.afterAvailable ? imageUrl("AFTER") : null}
          before={value.beforeAvailable ? imageUrl("BEFORE") : null}
          labels={imageLabels}
        />
      ) : value?.patch ? (
        <PatchDiffView
          labels={{ ...diffLabels, truncated: t("diffLimit") }}
          mode="UNIFIED"
          patch={value.patch}
          truncated={value.truncated}
          wrap={false}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {value?.truncated
            ? t("diffTooLarge")
            : value?.binary
              ? t("binaryFileChanged")
              : t("noTextChanges")}
        </p>
      )}
    </div>
  );
}

function useDiff(
  worktreeId: string,
  scope: DiffScope,
  path: string | null,
  previousPath: string | null,
  commitSha: string | null,
) {
  const [value, setValue] = useState<WorktreeFileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void controlPlaneRequest<{ inspectWorktreeDiff: WorktreeFileDiff }>(
      INSPECT_WORKTREE_DIFF_MUTATION,
      {
        input: {
          worktreeId,
          scope,
          path,
          previousPath,
          commitSha,
          requestId: createClientId(),
        },
      },
    )
      .then((data) => {
        if (!disposed) setValue(data.inspectWorktreeDiff);
      })
      .catch((reason) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [commitSha, path, previousPath, scope, worktreeId]);
  return { value, loading, error };
}

function LoadingDiff() {
  const t = useTranslations("worktreeDetail");
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner /> {t("loadingDiff")}
    </p>
  );
}

function DiffError({ value }: { value: string }) {
  return <p className="text-sm text-destructive">{value}</p>;
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
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
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
    <span className="inline-flex gap-1 text-xs tabular-nums">
      <span className="text-emerald-700 dark:text-emerald-400">
        +{additions ?? 0}
      </span>
      <span className="text-red-700 dark:text-red-400">−{deletions ?? 0}</span>
    </span>
  );
}
