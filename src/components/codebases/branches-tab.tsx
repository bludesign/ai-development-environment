"use client";

import type { CodebaseBranchDeletionOutcome } from "@ai-development-environment/agent-contract/codebases";
import { RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  branchKey,
  filterBranchRows,
  localBranchRows,
  reconcileBranchSelection,
  type BranchRow,
} from "./branches-model";
import type { CodebaseRepository } from "./types";

interface CleanupJob {
  id: string;
  codebaseId: string | null;
  status: string;
  error: string | null;
  branchDeletionResults: CodebaseBranchDeletionOutcome[] | null;
}
interface ProgressRow {
  row: BranchRow;
  outcome: string;
  reason: string | null;
}
const RESULT_FIELDS = "codebaseId branch outcome reason";
const JOB_FIELDS = `id codebaseId status error branchDeletionResults { ${RESULT_FIELDS} }`;
const PAGE_SIZE = 50;

export function BranchesTab({
  repositories,
  onReload,
  onRefresh,
}: {
  repositories: CodebaseRepository[];
  onReload: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const t = useTranslations("codebases.branchesTab");
  const [agent, setAgent] = useState("all");
  const [repository, setRepository] = useState("all");
  const [age, setAge] = useState("all");
  const [customAge, setCustomAge] = useState("30");
  const [now, setNow] = useState(() => Date.now());
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [review, setReview] = useState(false);
  const [force, setForce] = useState(false);
  const [forceReview, setForceReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressRow[]>([]);
  const controller = useRef<AbortController | null>(null);
  const allRows = useMemo(() => localBranchRows(repositories), [repositories]);
  const invalidAge =
    age === "custom" &&
    (!/^\d+$/.test(customAge) ||
      Number(customAge) <= 0 ||
      !Number.isSafeInteger(Number(customAge)));
  const days =
    age === "all" ? null : age === "custom" ? Number(customAge) : Number(age);
  const rows = useMemo(
    () =>
      invalidAge ? [] : filterBranchRows(allRows, agent, repository, days, now),
    [allRows, agent, repository, days, invalidAge, now],
  );
  const validSelection = reconcileBranchSelection(selection, rows);
  const selected = rows.filter(
    (row) => validSelection[row.key] === row.branch.headSha,
  );
  const eligible = rows.filter((row) => !row.restriction);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const agents = [
    ...new Map(
      repositories.flatMap((repository) =>
        repository.codebases.map(
          (codebase) => [codebase.agent.id, codebase.agent] as const,
        ),
      ),
    ).values(),
  ];

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSelection((value) => reconcileBranchSelection(value, allRows)),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [allRows]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const changeFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setSelection({});
    setPage(0);
  };
  const updateJob = (job: CleanupJob) => {
    const outcomes = new Map(
      (job.branchDeletionResults ?? []).map((result) => [
        branchKey(result.codebaseId, result.branch),
        result,
      ]),
    );
    const terminal = !["QUEUED", "RUNNING"].includes(job.status);
    setProgress((previous) =>
      previous.map((entry) => {
        if (entry.row.codebase.id !== job.codebaseId) return entry;
        const result = outcomes.get(entry.row.key);
        return result
          ? { ...entry, outcome: result.outcome, reason: result.reason }
          : {
              ...entry,
              outcome: terminal ? "FAILED" : job.status,
              reason: terminal ? job.error || t("uncertain") : null,
            };
      }),
    );
    return terminal;
  };

  const remove = async () => {
    if (!selected.length || busy) return;
    const targets = selected.map((row) => ({
      codebaseId: row.codebase.id,
      branch: row.branch.name,
      expectedHeadSha: row.branch.headSha,
    }));
    setBusy(true);
    setReview(false);
    setError(null);
    setProgress(
      selected.map((row) => ({ row, outcome: "QUEUED", reason: null })),
    );
    const abort = new AbortController();
    controller.current = abort;
    try {
      const data = await controlPlaneRequest<{
        deleteCodebaseBranches: {
          jobs: CleanupJob[];
          skipped: CodebaseBranchDeletionOutcome[];
        };
      }>(
        `mutation DeleteCodebaseBranches($input: DeleteCodebaseBranchesInput!) { deleteCodebaseBranches(input: $input) { jobs { ${JOB_FIELDS} } skipped { ${RESULT_FIELDS} } } }`,
        { input: { targets, requestId: createClientId(), force } },
        { signal: abort.signal },
      );
      const skipped = new Map(
        data.deleteCodebaseBranches.skipped.map((result) => [
          branchKey(result.codebaseId, result.branch),
          result,
        ]),
      );
      setProgress((previous) =>
        previous.map((entry) => {
          const result = skipped.get(entry.row.key);
          return result
            ? { ...entry, outcome: result.outcome, reason: result.reason }
            : entry;
        }),
      );
      await onReload();
      const jobs = await Promise.allSettled(
        data.deleteCodebaseBranches.jobs.map(async (initial) => {
          let job = initial;
          const deadline = Date.now() + 310_000;
          while (!abort.signal.aborted && !updateJob(job)) {
            if (Date.now() >= deadline) {
              updateJob({ ...job, status: "TIMED_OUT", error: t("uncertain") });
              break;
            }
            await new Promise<void>((resolve) => {
              const finish = () => {
                window.clearTimeout(timer);
                abort.signal.removeEventListener("abort", finish);
                resolve();
              };
              const timer = window.setTimeout(finish, 1_000);
              abort.signal.addEventListener("abort", finish, { once: true });
            });
            if (abort.signal.aborted) return;
            const data = await controlPlaneRequest<{
              agentJob: CleanupJob | null;
            }>(
              `query BranchDeletionJob($id: ID!) { agentJob(id: $id) { ${JOB_FIELDS} } }`,
              { id: job.id },
              { signal: abort.signal },
            );
            if (!data.agentJob) throw new Error(t("uncertain"));
            job = data.agentJob;
          }
        }),
      );
      if (!abort.signal.aborted) {
        if (jobs.some((job) => job.status === "rejected")) {
          setError(t("uncertain"));
          setProgress((previous) =>
            previous.map((entry) =>
              ["QUEUED", "RUNNING"].includes(entry.outcome)
                ? { ...entry, outcome: "FAILED", reason: t("uncertain") }
                : entry,
            ),
          );
          await onRefresh();
        }
        setSelection({});
        await onReload();
      }
    } catch (value) {
      if (!abort.signal.aborted) {
        setError(value instanceof Error ? value.message : String(value));
        setProgress((previous) =>
          previous.map((entry) =>
            ["QUEUED", "RUNNING"].includes(entry.outcome)
              ? { ...entry, outcome: "FAILED", reason: t("uncertain") }
              : entry,
          ),
        );
        await onRefresh();
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>{t("agent")}</Label>
          <Select
            value={agent}
            onValueChange={(value) => changeFilter(setAgent, value)}
          >
            <SelectTrigger aria-label={t("agent")} className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allAgents")}</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("repository")}</Label>
          <Select
            value={repository}
            onValueChange={(value) => changeFilter(setRepository, value)}
          >
            <SelectTrigger aria-label={t("repository")} className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allRepositories")}</SelectItem>
              {repositories.map((repository) => (
                <SelectItem key={repository.id} value={repository.id}>
                  {repository.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("olderThan")}</Label>
          <Select
            value={age}
            onValueChange={(value) => changeFilter(setAge, value)}
          >
            <SelectTrigger aria-label={t("olderThan")} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allAges")}</SelectItem>
              {[7, 30, 90].map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t("days", { count: days })}
                </SelectItem>
              ))}
              <SelectItem value="custom">{t("custom")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {age === "custom" && (
          <div className="space-y-1">
            <Label htmlFor="branch-custom-age">{t("customDays")}</Label>
            <Input
              id="branch-custom-age"
              type="number"
              min={1}
              step={1}
              value={customAge}
              className="w-28"
              aria-invalid={invalidAge}
              onChange={(event) =>
                changeFilter(setCustomAge, event.target.value)
              }
            />
          </div>
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void onRefresh()}
        >
          <RefreshCw />
          {t("refresh")}
        </Button>
      </div>
      {invalidAge && (
        <p role="alert" className="text-sm text-destructive">
          {t("invalidAge")}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-2">
          <Checkbox
            aria-label={t("selectAll")}
            disabled={busy || !eligible.length}
            checked={
              eligible.length > 0 && selected.length === eligible.length
                ? true
                : selected.length
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(checked) =>
              setSelection(
                checked
                  ? Object.fromEntries(
                      eligible.map((row) => [row.key, row.branch.headSha]),
                    )
                  : {},
              )
            }
          />
          {t("selectAll")}
        </Label>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t("selected", { count: selected.length })}
          </span>
          <Button
            variant="destructive"
            disabled={busy || !selected.length}
            onClick={() => {
              setForce(false);
              setReview(true);
            }}
          >
            <Trash2 />
            {t("deleteSelected")}
          </Button>
        </div>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>{t("branch")}</TableHead>
              <TableHead>{t("repository")}</TableHead>
              <TableHead>{t("agent")}</TableHead>
              <TableHead>{t("lastCommit")}</TableHead>
              <TableHead>{t("age")}</TableHead>
              <TableHead>{t("lastScan")}</TableHead>
              <TableHead>{t("status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows
              .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
              .map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <Checkbox
                      aria-label={t("selectBranch", {
                        branch: row.branch.name,
                        agent: row.codebase.agent.name,
                        folder: row.codebase.folder,
                      })}
                      disabled={busy || !!row.restriction}
                      checked={validSelection[row.key] === row.branch.headSha}
                      onCheckedChange={(checked) =>
                        setSelection((previous) => {
                          const next = { ...previous };
                          if (checked) next[row.key] = row.branch.headSha;
                          else delete next[row.key];
                          return next;
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className="font-mono">{row.branch.name}</TableCell>
                  <TableCell>
                    <div>{row.repository.name}</div>
                    <div className="max-w-72 break-all text-xs text-muted-foreground">
                      {row.codebase.folder}
                    </div>
                  </TableCell>
                  <TableCell>
                    {row.codebase.agent.name}
                    {row.codebase.agent.connectionStatus !== "ONLINE" && (
                      <Badge variant="outline" className="mt-1 block w-fit">
                        {t("cached")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="max-w-72 break-words">
                      {row.branch.lastCommitMessage || t("unknown")}
                    </div>
                    {row.branch.lastCommitAt && (
                      <DateTime
                        value={row.branch.lastCommitAt}
                        className="text-xs text-muted-foreground"
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {row.branch.lastCommitAt
                      ? t("days", {
                          count: Math.max(
                            0,
                            Math.floor(
                              (now - Date.parse(row.branch.lastCommitAt)) /
                                86_400_000,
                            ),
                          ),
                        })
                      : t("unknown")}
                  </TableCell>
                  <TableCell>
                    {row.scannedAt ? (
                      <DateTime value={row.scannedAt} />
                    ) : (
                      t("unknown")
                    )}
                  </TableCell>
                  <TableCell>
                    {row.restriction ? (
                      <span
                        title={
                          row.branch.checkedOutPath ||
                          row.codebase.localBranchInventoryError ||
                          undefined
                        }
                      >
                        {t(`restrictions.${row.restriction}`)}
                      </span>
                    ) : (
                      t("ready")
                    )}
                  </TableCell>
                </TableRow>
              ))}
            {!rows.length && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-8 text-center text-muted-foreground"
                >
                  {t("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t("page", { page: currentPage + 1, pages, count: rows.length })}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t("previous")}
          </Button>
          <Button
            variant="outline"
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            {t("next")}
          </Button>
        </div>
      </div>
      {!!progress.length && (
        <div aria-live="polite" className="space-y-2 rounded-md border p-4">
          <p className="font-medium">{t("results")}</p>
          {progress.map(({ row, outcome, reason }) => (
            <div key={row.key} className="text-sm">
              <span className="font-mono">{row.branch.name}</span> ·{" "}
              {row.codebase.agent.name} · {row.codebase.folder} —{" "}
              <span>{t(`outcomes.${outcome}`)}</span>
              {reason && <p className="text-muted-foreground">{reason}</p>}
            </div>
          ))}
        </div>
      )}
      <Dialog open={review} onOpenChange={setReview}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("reviewTitle")}</DialogTitle>
            <DialogDescription>
              {t("reviewDescription", { count: selected.length })}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-2 overflow-auto text-sm">
            {selected.map((row) => (
              <li key={row.key}>
                <span className="font-mono font-medium">{row.branch.name}</span>
                <div className="text-muted-foreground">
                  {row.codebase.agent.name} · {row.codebase.folder}
                </div>
              </li>
            ))}
          </ul>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={force}
              onCheckedChange={(checked) =>
                checked ? setForceReview(true) : setForce(false)
              }
            />
            {t("force")}
          </Label>
          {force && (
            <p className="text-sm text-destructive">{t("forceWarning")}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!selected.length || busy}
              onClick={() => void remove()}
            >
              {t("deleteSelected")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmationDialog
        open={forceReview}
        onOpenChange={setForceReview}
        title={t("forceTitle")}
        description={t("forceWarning")}
        actionLabel={t("enableForce")}
        cancelLabel={t("cancel")}
        onConfirm={() => {
          setForce(true);
          setForceReview(false);
        }}
      />
    </div>
  );
}
