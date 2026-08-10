"use client";

import {
  FolderOpen,
  GitBranch,
  Monitor,
  RotateCcw,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { waitForWorktreeJob } from "@/components/worktrees/worktree-jobs";

type PreparationState =
  | "PENDING"
  | "APPLIED"
  | "UNDONE"
  | "DRIFTED"
  | "SUSPENDED"
  | "NOT_APPLICABLE"
  | "ERROR"
  | "UNKNOWN"
  | "NOT_CONFIGURED";

type Preparation = {
  id: string;
  kind: "WRITE" | "DELETE" | "ASSUME_UNCHANGED";
  path: string;
  contentSha256: string | null;
  byteCount: number | null;
  definitionHash: string;
};

type PreparationWorktree = {
  worktree: {
    id: string;
    folder: string;
    relativePath: string;
    branch: string | null;
    headSha: string | null;
    primary: boolean;
    availability: string;
  };
  agent: { id: string; name: string; hostname: string };
  supported: boolean;
  unsupportedReason: string | null;
  overallState: PreparationState;
  statuses: Array<{
    preparation: Preparation;
    state: PreparationState;
    message: string | null;
    checkedAt: string | null;
  }>;
  activeJob: { id: string; status: string } | null;
};

type PreparationOverview = {
  repositories: Array<{
    repository: {
      id: string;
      name: string;
      displayOrigin: string;
      preparations: Preparation[];
    };
    worktrees: PreparationWorktree[];
  }>;
};

const OVERVIEW_FIELDS = `
  repositories {
    repository {
      id name displayOrigin
      preparations { id kind path contentSha256 byteCount definitionHash }
    }
    worktrees {
      worktree { id folder relativePath branch headSha primary availability }
      agent { id name hostname }
      supported unsupportedReason overallState
      statuses {
        state message checkedAt
        preparation { id kind path contentSha256 byteCount definitionHash }
      }
      activeJob { id status }
    }
  }
`;

function stateClass(state: PreparationState): string {
  if (state === "APPLIED") {
    return "border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  }
  if (["PENDING", "UNDONE", "SUSPENDED"].includes(state)) {
    return "border-amber-600/30 bg-amber-500/15 text-amber-800 dark:text-amber-300";
  }
  if (["DRIFTED", "ERROR"].includes(state)) {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted text-muted-foreground";
}

function shortFolder(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

function branchLabel(
  worktree: PreparationWorktree["worktree"],
  detachedAt: (values: { sha: string }) => string,
): string {
  if (worktree.branch) return worktree.branch;
  return detachedAt({ sha: worktree.headSha?.slice(0, 8) ?? "unknown" });
}

export function PreparePage() {
  const t = useTranslations("prepare");
  const [overview, setOverview] = useState<PreparationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    action: "APPLY" | "UNDO";
    worktreeIds: string[];
  } | null>(null);
  const inspectionRequested = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        worktreePreparationOverview: PreparationOverview;
      }>(
        `query WorktreePreparationOverview {
          worktreePreparationOverview { ${OVERVIEW_FIELDS} }
        }`,
      );
      setOverview(data.worktreePreparationOverview);
      setError(null);
      return data.worktreePreparationOverview;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const run = useCallback(
    async (action: "INSPECT" | "APPLY" | "UNDO", worktreeIds: string[]) => {
      if (!worktreeIds.length) return;
      setRunning(true);
      setRunningIds((current) => new Set([...current, ...worktreeIds]));
      setError(null);
      try {
        const data = await controlPlaneRequest<{
          runWorktreePreparations: {
            jobs: Array<{ id: string }>;
            skipped: Array<{ worktreeId: string; reason: string }>;
          };
        }>(
          `mutation RunWorktreePreparations($input: RunWorktreePreparationsInput!) {
            runWorktreePreparations(input: $input) {
              jobs { id }
              skipped { worktreeId reason }
            }
          }`,
          {
            input: {
              action,
              worktreeIds,
              requestId: crypto.randomUUID(),
            },
          },
        );
        const skippedMessage = data.runWorktreePreparations.skipped
          .map((item) => item.reason)
          .join("; ");
        await load();
        await Promise.all(
          data.runWorktreePreparations.jobs.map((job) =>
            waitForWorktreeJob(job.id),
          ),
        );
        await load();
        if (skippedMessage) setError(skippedMessage);
      } catch (value) {
        await load();
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setRunning(false);
        setRunningIds((current) => {
          const next = new Set(current);
          worktreeIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    },
    [load],
  );

  useEffect(() => {
    let active = true;
    const initial = window.setTimeout(async () => {
      const value = await load();
      if (!active || !value) return;
      const eligible = value.repositories.flatMap((group) =>
        group.worktrees
          .filter(
            (item) =>
              item.supported &&
              !item.activeJob &&
              group.repository.preparations.length > 0 &&
              !inspectionRequested.current.has(item.worktree.id),
          )
          .map((item) => item.worktree.id),
      );
      eligible.forEach((id) => inspectionRequested.current.add(id));
      await run("INSPECT", eligible);
    }, 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      worktreeOverviewChanged: { worktreeId: string | null };
    }>(
      {
        query:
          "subscription PreparationsChanged { worktreeOverviewChanged { worktreeId codebaseId } }",
      },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      active = false;
      window.clearTimeout(initial);
      unsubscribe();
    };
  }, [load, run]);

  const eligibleIds = useMemo(
    () =>
      overview?.repositories.flatMap((group) =>
        group.worktrees
          .filter(
            (item) =>
              item.supported &&
              !item.activeJob &&
              group.repository.preparations.length > 0,
          )
          .map((item) => item.worktree.id),
      ) ?? [],
    [overview],
  );

  return (
    <section className="mx-auto flex w-full max-w-[1800px] flex-col gap-6">
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
            disabled={running || eligibleIds.length === 0}
            onClick={() =>
              setConfirmation({ action: "APPLY", worktreeIds: eligibleIds })
            }
          >
            {running ? <Spinner /> : <Sparkles />} {t("applyAll")}
          </Button>
          <Button
            disabled={running || eligibleIds.length === 0}
            onClick={() =>
              setConfirmation({ action: "UNDO", worktreeIds: eligibleIds })
            }
            className="text-destructive hover:text-destructive"
            variant="outline"
          >
            <Undo2 /> {t("undoAll")}
          </Button>
          <Button
            aria-label={t("refresh")}
            disabled={running}
            onClick={() => void load()}
            size="icon"
            variant="outline"
          >
            <RotateCcw />
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && !overview ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : null}

      {overview?.repositories.map((group) => {
        const repositoryEligibleIds = group.worktrees
          .filter(
            (item) =>
              item.supported &&
              !item.activeJob &&
              group.repository.preparations.length > 0,
          )
          .map((item) => item.worktree.id);
        return (
          <Card className="min-w-0 overflow-hidden" key={group.repository.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle>{group.repository.name}</CardTitle>
                <CardDescription className="truncate font-mono text-xs">
                  {group.repository.displayOrigin}
                </CardDescription>
              </div>
              <Button
                disabled={running || repositoryEligibleIds.length === 0}
                onClick={() =>
                  setConfirmation({
                    action: "APPLY",
                    worktreeIds: repositoryEligibleIds,
                  })
                }
                size="sm"
              >
                {repositoryEligibleIds.some((id) => runningIds.has(id)) ? (
                  <Spinner />
                ) : (
                  <Sparkles />
                )}{" "}
                {t("applyAll")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {group.worktrees.map((item) => (
                  <div
                    className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
                    key={item.worktree.id}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {shortFolder(item.worktree.relativePath)}
                          </span>
                          <Badge variant="secondary">
                            {item.worktree.primary
                              ? t("primaryType")
                              : t("linked")}
                          </Badge>
                        </div>
                        <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <Monitor className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {item.agent.name} · {item.agent.hostname}
                          </span>
                        </span>
                      </div>
                      <Badge
                        className={stateClass(item.overallState)}
                        variant="outline"
                      >
                        {t(`states.${item.overallState}` as never)}
                      </Badge>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <GitBranch className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {branchLabel(item.worktree, (values) =>
                            t("detachedAt", values),
                          )}
                        </span>
                      </span>
                      <span
                        className="flex items-center gap-1"
                        title={item.worktree.folder}
                      >
                        <FolderOpen className="size-3.5 shrink-0" />
                        <span className="truncate font-mono">
                          {item.worktree.folder}
                        </span>
                      </span>
                    </div>
                    {!item.supported && item.unsupportedReason ? (
                      <p className="text-xs text-destructive">
                        {item.unsupportedReason}
                      </p>
                    ) : null}
                    {item.supported &&
                    group.repository.preparations.length > 0 ? (
                      <div className="mt-auto flex gap-2">
                        <Button
                          disabled={Boolean(item.activeJob) || running}
                          onClick={() =>
                            setConfirmation({
                              action: "APPLY",
                              worktreeIds: [item.worktree.id],
                            })
                          }
                          size="sm"
                        >
                          {runningIds.has(item.worktree.id) ? (
                            <Spinner />
                          ) : (
                            <Sparkles />
                          )}{" "}
                          {t("apply")}
                        </Button>
                        <Button
                          disabled={Boolean(item.activeJob) || running}
                          onClick={() =>
                            setConfirmation({
                              action: "UNDO",
                              worktreeIds: [item.worktree.id],
                            })
                          }
                          size="sm"
                          variant="outline"
                        >
                          <Undo2 /> {t("undo")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              {group.repository.preparations.length === 0 ? (
                <Alert>
                  <AlertDescription>{t("notConfigured")}</AlertDescription>
                </Alert>
              ) : (
                <div className="w-full max-w-full overflow-x-auto rounded-lg border">
                  <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="bg-muted/60">
                        <th className="sticky left-0 z-20 w-72 min-w-72 border-b border-r bg-muted px-3 py-3 text-left font-medium">
                          {t("path")}
                        </th>
                        {group.worktrees.map((item) => (
                          <th
                            className="w-72 min-w-72 border-b border-r px-3 py-3 text-left font-medium last:border-r-0"
                            key={item.worktree.id}
                          >
                            <span className="flex items-center gap-2">
                              <span className="truncate">
                                {shortFolder(item.worktree.relativePath)}
                              </span>
                              <Badge variant="secondary">
                                {item.worktree.primary
                                  ? t("primaryType")
                                  : t("linked")}
                              </Badge>
                            </span>
                            <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                              {item.agent.name} · {item.agent.hostname}
                            </span>
                            <span className="block truncate font-mono text-xs font-normal text-muted-foreground">
                              {branchLabel(item.worktree, (values) =>
                                t("detachedAt", values),
                              )}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.repository.preparations.map((preparation) => (
                        <tr
                          className="border-b last:border-0"
                          key={preparation.id}
                        >
                          <th className="sticky left-0 z-10 border-b border-r bg-card px-3 py-3 text-left font-normal group-last:border-b-0">
                            <span className="block font-mono text-xs">
                              {preparation.path}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {t(`kinds.${preparation.kind}` as never)}
                            </span>
                          </th>
                          {group.worktrees.map((item) => {
                            const status = item.statuses.find(
                              (candidate) =>
                                candidate.preparation.id === preparation.id,
                            );
                            const state = status?.state ?? item.overallState;
                            return (
                              <td
                                className="border-b border-r px-3 py-3 last:border-r-0"
                                key={item.worktree.id}
                              >
                                <Badge
                                  className={stateClass(state)}
                                  title={
                                    status?.message ??
                                    item.unsupportedReason ??
                                    undefined
                                  }
                                  variant="outline"
                                >
                                  {t(`states.${state}` as never)}
                                </Badge>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {overview && overview.repositories.length === 0 ? (
        <Alert>
          <AlertDescription>{t("noRepositories")}</AlertDescription>
        </Alert>
      ) : null}

      <ConfirmationDialog
        actionLabel={confirmation?.action === "UNDO" ? t("undo") : t("apply")}
        cancelLabel={t("cancel")}
        description={t("confirmDescription")}
        onConfirm={async () => {
          if (!confirmation) return;
          const pending = confirmation;
          setConfirmation(null);
          await run(pending.action, pending.worktreeIds);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        open={confirmation !== null}
        title={
          confirmation?.action === "UNDO"
            ? t("confirmUndoTitle")
            : t("confirmApplyTitle")
        }
      />
    </section>
  );
}
