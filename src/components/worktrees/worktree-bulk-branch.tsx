"use client";

import {
  validGitBranchName,
  WORKTREE_BRANCH_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import { ExternalLink, GitBranch } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { SearchableSelect } from "@/components/common/searchable-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import type { Worktree, WorktreeAgentGroup } from "./types";
import {
  WorktreeBranchForm,
  type WorktreeBranchMode,
  type WorktreeBranchSelection,
} from "./worktree-branch-form";
import { worktreeDetailHref } from "./worktree-navigation";

type BranchBatchItem = {
  id: string;
  worktreeId: string;
  codebaseId: string;
  repositoryName: string;
  agentName: string;
  folder: string;
  sourceBranch: string | null;
  baseBranch: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "SKIPPED" | "FAILED";
  error: string | null;
  warning: string | null;
  jobId: string | null;
};

type BranchBatch = {
  id: string;
  appId: string | null;
  agentId: string | null;
  mode: WorktreeBranchMode;
  branchName: string;
  ticketKey: string | null;
  status: "ACTIVE" | "COMPLETED";
  items: BranchBatchItem[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

const BATCH_FIELDS = `
  id appId agentId mode branchName ticketKey status createdAt updatedAt finishedAt
  items {
    id worktreeId codebaseId repositoryName agentName folder sourceBranch
    baseBranch status error warning jobId
  }
`;

type BlockReason =
  | "unavailable"
  | "offline"
  | "unsupported"
  | "busy"
  | "conflicts"
  | "missingBase"
  | "alreadyOnBranch"
  | "branchUnavailable"
  | "branchExists"
  | "branchCheckedOut"
  | "sameCheckout";

type Candidate = {
  worktree: Worktree;
  codebaseId: string;
  repositoryName: string;
  agentName: string;
  baseBranch: string;
  blocked: BlockReason | null;
};

function pending(item: BranchBatchItem) {
  return item.status === "PENDING" || item.status === "RUNNING";
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

function useBranchBatches(
  appId: string | null,
  agentId: string | null,
  onReload: () => Promise<void>,
) {
  const [batches, setBatches] = useState<BranchBatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(new Map<string, BranchBatch>());
  const missingBatch = useTranslations("worktrees.bulkBranch")("missingBatch");
  const record = useCallback(
    (incoming: BranchBatch[], started = false) => {
      let finished = false;
      for (const batch of incoming) {
        const prior = latest.current.get(batch.id);
        if (
          prior &&
          (prior.updatedAt > batch.updatedAt ||
            (prior.status === "COMPLETED" && batch.status === "ACTIVE"))
        )
          continue;
        latest.current.set(batch.id, batch);
        finished ||= Boolean(
          batch.status === "COMPLETED" &&
          (prior?.status === "ACTIVE" || started),
        );
      }
      const ordered = [...latest.current.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const completed = ordered
        .filter(({ status }) => status === "COMPLETED")
        .sort(
          (a, b) =>
            (b.finishedAt ?? b.updatedAt).localeCompare(
              a.finishedAt ?? a.updatedAt,
            ) || b.id.localeCompare(a.id),
        )[0];
      const visible = ordered.filter(
        (batch) => batch.status === "ACTIVE" || batch === completed,
      );
      latest.current = new Map(visible.map((batch) => [batch.id, batch]));
      setBatches(visible);
      if (finished) void onReload().catch(() => undefined);
    },
    [onReload],
  );

  const readScope = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await controlPlaneRequest<{
          worktreeBranchBatches: BranchBatch[];
        }>(
          `query WorktreeBranchBatches($appId: ID, $agentId: ID) {
            worktreeBranchBatches(appId: $appId, agentId: $agentId) { ${BATCH_FIELDS} }
          }`,
          { appId, agentId },
          { signal },
        );
        if (signal?.aborted) return;
        record(data.worktreeBranchBatches ?? []);
        setError(null);
      } catch (value) {
        if (!signal?.aborted) setError(errorMessage(value));
      }
    },
    [appId, agentId, record],
  );

  const activeIds = JSON.stringify(
    batches.filter(({ status }) => status === "ACTIVE").map(({ id }) => id),
  );

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void readScope(controller.signal);
    const initial = window.setTimeout(refresh, 0);
    const recovery = onControlPlaneRecovery(refresh);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      recovery();
    };
  }, [readScope]);

  useEffect(() => {
    const ids = JSON.parse(activeIds) as string[];
    if (!ids.length) return;
    const controller = new AbortController();
    let reading = false;
    const poll = async () => {
      if (reading || controller.signal.aborted) return;
      reading = true;
      try {
        const results = await Promise.allSettled(
          ids.map(async (id) => {
            const data = await controlPlaneRequest<{
              worktreeBranchBatch: BranchBatch | null;
            }>(
              `query WorktreeBranchBatch($id: ID!) {
                worktreeBranchBatch(id: $id) { ${BATCH_FIELDS} }
              }`,
              { id },
              { signal: controller.signal },
            );
            if (!data.worktreeBranchBatch) throw new Error(missingBatch);
            return data.worktreeBranchBatch;
          }),
        );
        if (controller.signal.aborted) return;
        const received = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        record(received);
        const failure = results.find((result) => result.status === "rejected");
        setError(failure ? errorMessage(failure.reason) : null);
      } finally {
        reading = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeIds, missingBatch, record]);

  return { batches, error, readScope, record };
}

function worktreeCandidates(
  agents: WorktreeAgentGroup[],
  allAgents: WorktreeAgentGroup[],
  batches: BranchBatch[],
  selection: WorktreeBranchSelection,
): Candidate[] {
  const branch = selection.branchName?.trim();
  const activeCodebases = new Set(
    batches.flatMap(({ items }) =>
      items.filter(pending).map(({ codebaseId }) => codebaseId),
    ),
  );
  const siblings = new Map(
    allAgents.flatMap(({ codebases }) =>
      codebases.map(({ codebase, worktrees }) => [codebase.id, worktrees]),
    ),
  );

  return agents.flatMap(({ agent, codebases }) =>
    codebases.flatMap((group) => {
      const { codebase, repository, worktrees } = group;
      const remote = new Set(codebase.remoteBranches);
      const exists = branch
        ? remote.has(branch) || codebase.localBranches.includes(branch)
        : false;
      return worktrees.map((worktree): Candidate => {
        const baseBranch =
          selection.baseBranch ||
          (worktree.baseBranch && remote.has(worktree.baseBranch)
            ? worktree.baseBranch
            : (codebase.defaultBranch ?? ""));
        let blocked: BlockReason | null = null;
        if (
          worktree.availability !== "AVAILABLE" ||
          worktree.missingAt ||
          codebase.availability !== "AVAILABLE"
        )
          blocked = "unavailable";
        else if (agent.connectionStatus !== "ONLINE") blocked = "offline";
        else if (!agent.capabilities.includes(WORKTREE_BRANCH_JOB_KIND))
          blocked = "unsupported";
        else if (
          group.blockingJob ||
          worktree.blockingJob ||
          activeCodebases.has(codebase.id)
        )
          blocked = "busy";
        else if (worktree.rebaseInProgress || worktree.hasConflicts)
          blocked = "conflicts";
        else if (!remote.has(baseBranch)) blocked = "missingBase";
        else if (branch) {
          if (worktree.branch === branch) blocked = "alreadyOnBranch";
          else if (
            (siblings.get(codebase.id) ?? worktrees).some(
              (sibling) =>
                sibling.id !== worktree.id &&
                !sibling.missingAt &&
                sibling.branch === branch,
            )
          )
            blocked = "branchCheckedOut";
          else if (selection.mode === "EXISTING" && !exists)
            blocked = "branchUnavailable";
          else if (selection.mode !== "EXISTING" && exists)
            blocked = "branchExists";
        }
        return {
          worktree,
          codebaseId: codebase.id,
          repositoryName: repository.name,
          agentName: agent.name,
          baseBranch: remote.has(baseBranch) ? baseBranch : "",
          blocked,
        };
      });
    }),
  );
}

function itemKey({ worktree, baseBranch }: Candidate) {
  return JSON.stringify([worktree.id, worktree.branch, baseBranch]);
}

export function WorktreeBulkBranch({
  agents,
  allAgents,
  appId,
  agentId,
  disabled,
  onReload,
}: {
  agents: WorktreeAgentGroup[];
  allAgents: WorktreeAgentGroup[];
  appId?: string;
  agentId: string | null;
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  const t = useTranslations("worktrees.bulkBranch");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{
    target: string;
    items: Set<string>;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [namingCheckout, setNamingCheckout] = useState("");
  const submission = useRef<{ fingerprint: string; requestId: string } | null>(
    null,
  );
  const { batches, error, readScope, record } = useBranchBatches(
    appId ?? null,
    agentId,
    onReload,
  );
  const activeCount = batches.filter(
    ({ status }) => status === "ACTIVE",
  ).length;
  const { target, namingOptions } = useMemo(() => {
    const groups = agents.flatMap(({ codebases }) =>
      codebases.filter(({ worktrees }) => worktrees.length > 0),
    );
    const namingOptions = agents.flatMap(({ agent, codebases }) =>
      agent.connectionStatus === "ONLINE" &&
      agent.capabilities.includes(WORKTREE_BRANCH_JOB_KIND)
        ? codebases
            .filter(({ codebase }) => codebase.availability === "AVAILABLE")
            .flatMap(({ codebase, repository, worktrees }) =>
              worktrees
                .filter(
                  ({ availability, missingAt }) =>
                    availability === "AVAILABLE" && !missingAt,
                )
                .map((worktree) => ({
                  value: worktree.id,
                  codebaseId: codebase.id,
                  label: `${repository.name} · ${agent.name}`,
                  description: worktree.folder,
                })),
            )
        : [],
    );
    const reference =
      namingOptions.find(({ value }) => value === namingCheckout) ??
      namingOptions[0];
    const codebaseId = reference?.codebaseId ?? groups[0]?.codebase.id;
    if (!codebaseId) return { target: null, namingOptions };
    const branches = (kind: "localBranches" | "remoteBranches") =>
      [...new Set(groups.flatMap(({ codebase }) => codebase[kind]))].sort(
        (a, b) => a.localeCompare(b),
      );
    return {
      namingOptions,
      target: {
        codebaseId,
        worktreeId: reference?.value,
        defaultBranch: null,
        localBranches: branches("localBranches"),
        remoteBranches: branches("remoteBranches"),
        unavailableBranches: [],
      },
    };
  }, [agents, namingCheckout]);

  function choices(selection: WorktreeBranchSelection) {
    const branchName = selection.branchName?.trim() ?? "";
    const targetKey = JSON.stringify([
      selection.mode,
      branchName,
      selection.ticketKey,
      selection.baseBranch,
      selection.mode === "TICKET" ? target?.worktreeId : null,
    ]);
    const checked = selected?.target === targetKey ? selected.items : null;
    const rows = worktreeCandidates(agents, allAgents, batches, selection);
    const ready = validGitBranchName(branchName);
    const selectedRows = ready
      ? rows.filter((row) => !row.blocked && checked?.has(itemKey(row)))
      : [];
    return { rows, selectedRows, targetKey, branchName, ready };
  }

  function renderSelection(selection: WorktreeBranchSelection) {
    const { rows, selectedRows, targetKey, branchName, ready } =
      choices(selection);
    const selectedIds = new Set(
      selectedRows.map(({ worktree }) => worktree.id),
    );
    const selectedCodebases = new Set(
      selectedRows.map(({ codebaseId }) => codebaseId),
    );
    return {
      count: disabled ? 0 : selectedRows.length,
      content: (
        <section className="space-y-3" aria-label={t("selection")}>
          <h3 className="font-medium">{t("selection")}</h3>
          {!ready && (
            <p className="text-sm text-muted-foreground">
              {t(branchName ? "invalidBranch" : "chooseBranch")}
            </p>
          )}
          {ready && (
            <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border sm:max-h-96">
              {rows.map((row) => {
                const { worktree } = row;
                const checked = selectedIds.has(worktree.id);
                const reason =
                  row.blocked ??
                  (!checked && selectedCodebases.has(row.codebaseId)
                    ? "sameCheckout"
                    : null);
                const label = worktree.branch ?? worktree.relativePath;
                return (
                  <li className="flex gap-3 p-3" key={worktree.id}>
                    <Checkbox
                      aria-label={t("selectWorktree", { branch: label })}
                      checked={checked}
                      disabled={disabled || submitting || Boolean(reason)}
                      id={`bulk-branch-${worktree.id}`}
                      onCheckedChange={(next) =>
                        setSelected((current) => {
                          const items = new Set(
                            current?.target === targetKey ? current.items : [],
                          );
                          if (next) items.add(itemKey(row));
                          else items.delete(itemKey(row));
                          return { target: targetKey, items };
                        })
                      }
                    />
                    <div className="min-w-0 space-y-1">
                      <Label
                        className="break-all leading-snug"
                        htmlFor={`bulk-branch-${worktree.id}`}
                      >
                        {label}
                      </Label>
                      <p className="break-words text-sm text-muted-foreground">
                        {row.repositoryName} · {row.agentName}
                      </p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {worktree.folder}
                      </p>
                      {row.baseBranch && (
                        <p className="text-xs text-muted-foreground">
                          {t("rowBase", { branch: row.baseBranch })}
                        </p>
                      )}
                      {reason && (
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                          {t(`blocked.${reason}`)}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ),
    };
  }

  const start = async (selection: WorktreeBranchSelection) => {
    const { selectedRows, branchName } = choices(selection);
    if (!selectedRows.length || submitting || disabled) return;
    const items = selectedRows
      .map(({ worktree, baseBranch }) => ({
        worktreeId: worktree.id,
        expectedBranch: worktree.branch,
        baseBranch,
      }))
      .sort((a, b) => a.worktreeId.localeCompare(b.worktreeId));
    const input = {
      appId: appId ?? null,
      agentId,
      mode: selection.mode,
      branchName,
      ticketKey: selection.ticketKey ?? null,
      items,
    };
    const fingerprint = JSON.stringify(input);
    if (submission.current?.fingerprint !== fingerprint) {
      submission.current = { fingerprint, requestId: createClientId() };
    }
    setSubmitting(true);
    try {
      const { startWorktreeBranchBatch: batch } = await controlPlaneRequest<{
        startWorktreeBranchBatch: BranchBatch;
      }>(
        `mutation StartWorktreeBranchBatch($input: StartWorktreeBranchBatchInput!) {
          startWorktreeBranchBatch(input: $input) { ${BATCH_FIELDS} }
        }`,
        { input: { ...input, requestId: submission.current.requestId } },
      );
      record([batch], true);
      setSelected(null);
      submission.current = null;
    } catch (value) {
      void readScope();
      throw value;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        if (next) void readScope();
        if (!next) {
          setSelected(null);
          setNamingCheckout("");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          aria-label={t("button")}
          disabled={disabled && batches.length === 0}
          variant="outline"
        >
          {activeCount ? <Spinner aria-hidden="true" /> : <GitBranch />}
          {t("button")}
          {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b p-4 pr-12">
          <DialogTitle>{t("button")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {error && (
            <Alert>
              <AlertDescription>
                {t("monitoringError", { message: error })}
              </AlertDescription>
            </Alert>
          )}
          {batches.map((batch) => (
            <BranchBatchProgress key={batch.id} batch={batch} />
          ))}
          {target ? (
            <WorktreeBranchForm
              busy={submitting}
              onSubmit={start}
              renderBulkSelection={renderSelection}
              submitLabel={t("button")}
              target={target}
              ticketTarget={
                namingOptions.length > 0 && (
                  <div>
                    <Label className="mb-1.5 block">
                      {t("namingCheckout")}
                    </Label>
                    <SearchableSelect
                      ariaLabel={t("namingCheckout")}
                      disabled={submitting}
                      emptyMessage={t("noNamingCheckouts")}
                      onValueChange={setNamingCheckout}
                      options={namingOptions}
                      placeholder={t("namingCheckout")}
                      searchPlaceholder={t("searchCheckouts")}
                      value={target.worktreeId ?? ""}
                    />
                  </div>
                )
              }
            />
          ) : (
            <p className="text-muted-foreground">{t("empty")}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BranchBatchProgress({ batch }: { batch: BranchBatch }) {
  const t = useTranslations("worktrees.bulkBranch");
  const completed = batch.items.filter((item) => !pending(item)).length;
  const progress = t("progress", { completed, total: batch.items.length });
  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div role="status" aria-atomic="true" className="space-y-1">
        <h3 className="flex items-center gap-2 font-medium">
          {batch.status === "ACTIVE" && <Spinner aria-hidden="true" />}
          {t(batch.status === "ACTIVE" ? "running" : "completed")}
        </h3>
        <p className="break-all font-mono text-sm">{batch.branchName}</p>
        <p className="text-sm">{progress}</p>
        <p className="text-xs text-muted-foreground">
          <DateTime hover={false} value={batch.createdAt} />
        </p>
      </div>
      <progress
        aria-label={progress}
        className="h-1.5 w-full accent-primary"
        max={Math.max(1, batch.items.length)}
        value={completed}
      />
      <ul className="divide-y">
        {batch.items.map((item) => (
          <li className="space-y-1 py-3 first:pt-0 last:pb-0" key={item.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link
                className="min-w-0 break-all font-medium hover:underline"
                href={worktreeDetailHref(item.worktreeId)}
              >
                {item.sourceBranch ?? item.folder}
              </Link>
              <Badge
                variant={
                  item.status === "FAILED"
                    ? "destructive"
                    : item.status === "SUCCEEDED"
                      ? "success"
                      : "outline"
                }
              >
                {t(`status.${item.status}`)}
              </Badge>
            </div>
            <p className="break-words text-xs text-muted-foreground">
              {item.repositoryName} · {item.agentName}
            </p>
            {item.sourceBranch && (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {item.folder}
              </p>
            )}
            {item.error && (
              <p className="break-words text-sm text-destructive">
                {item.error}
              </p>
            )}
            {item.warning && (
              <p className="break-words text-sm text-amber-700 dark:text-amber-300">
                {item.warning}
              </p>
            )}
            {item.jobId && (
              <Link
                className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
                href={`/dashboard/jobs/${encodeURIComponent(item.jobId)}`}
              >
                {t("job")}
                <ExternalLink className="size-3" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
