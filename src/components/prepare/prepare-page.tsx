"use client";

import { RotateCcw, Sparkles, Undo2 } from "lucide-react";
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
    branch: string | null;
    primary: boolean;
    availability: string;
  };
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
      worktree { id folder branch primary availability }
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

export function PreparePage() {
  const t = useTranslations("prepare");
  const [overview, setOverview] = useState<PreparationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
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
        if (data.runWorktreePreparations.skipped.length) {
          setError(
            data.runWorktreePreparations.skipped
              .map((item) => item.reason)
              .join("; "),
          );
        }
        await load();
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setRunning(false);
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
            variant="destructive"
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

      {overview?.repositories.map((group) => (
        <Card key={group.repository.id}>
          <CardHeader>
            <CardTitle>{group.repository.name}</CardTitle>
            <CardDescription className="font-mono text-xs">
              {group.repository.displayOrigin}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {group.worktrees.map((item) => (
                <div
                  className="flex items-center gap-2 rounded-lg border px-3 py-2"
                  key={item.worktree.id}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {item.worktree.primary
                        ? t("primary", {
                            name: shortFolder(item.worktree.folder),
                          })
                        : shortFolder(item.worktree.folder)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {item.worktree.branch ?? t("detached")}
                    </span>
                  </span>
                  <Badge
                    className={stateClass(item.overallState)}
                    variant="outline"
                  >
                    {t(`states.${item.overallState}` as never)}
                  </Badge>
                  {item.supported &&
                  group.repository.preparations.length > 0 ? (
                    <>
                      <Button
                        disabled={Boolean(item.activeJob) || running}
                        onClick={() =>
                          setConfirmation({
                            action: "APPLY",
                            worktreeIds: [item.worktree.id],
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
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
                        variant="ghost"
                      >
                        {t("undo")}
                      </Button>
                    </>
                  ) : null}
                </div>
              ))}
            </div>

            {group.repository.preparations.length === 0 ? (
              <Alert>
                <AlertDescription>{t("notConfigured")}</AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="min-w-max border-collapse text-sm">
                  <thead>
                    <tr className="border-b bg-muted/60">
                      <th className="sticky left-0 z-20 min-w-72 bg-muted px-3 py-2 text-left font-medium">
                        {t("path")}
                      </th>
                      {group.worktrees.map((item) => (
                        <th
                          className="min-w-44 px-3 py-2 text-left font-medium"
                          key={item.worktree.id}
                        >
                          {shortFolder(item.worktree.folder)}
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
                        <th className="sticky left-0 z-10 bg-card px-3 py-3 text-left font-normal">
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
                            <td className="px-3 py-3" key={item.worktree.id}>
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
      ))}

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
