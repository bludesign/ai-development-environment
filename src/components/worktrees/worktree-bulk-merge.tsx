"use client";

import { ChevronDown, GitMerge, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DateTime } from "@/components/common/date-time";
import {
  BASE_BRANCH_UPDATE_FIELDS,
  MERGE_FOLLOW_UP_FIELDS,
  POST_MERGE_SWITCH_OPTION_FIELDS,
} from "@/components/github/merge-follow-up-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import type { GitHubPullRequestMergeOptions } from "@/services/github/types";
import type { GitLabMergeOptions } from "@/services/gitlab/types";
import {
  bulkMergeDefaults,
  bulkMergeDraftValid,
  bulkMergeFollowUpInput,
  bulkMergeGitLabMessages,
  BulkMergeSettings,
  type BulkMergeDraft,
  type BulkMergeOptions,
} from "./worktree-bulk-merge-settings";

type MergeRequestRow = {
  worktreeId: string;
  repositoryName: string;
  agentName: string;
  branch: string;
  folder: string;
  provider: "GITHUB" | "GITLAB";
  requestKey: string;
  requestNumber: number;
  requestTitle: string;
  requestUrl: string;
};

type Candidate = MergeRequestRow & {
  repositoryNameWithOwner: string | null;
  projectId: string | null;
  reviewedHeadSha: string | null;
  reviewedTargetBranch: string | null;
  blockedReason: string | null;
  githubOptions: GitHubPullRequestMergeOptions | null;
  gitlabOptions: GitLabMergeOptions | null;
};

type BatchItem = MergeRequestRow & {
  id: string;
  status:
    | "PENDING"
    | "SUBMITTING"
    | "MERGED"
    | "SKIPPED"
    | "FAILED"
    | "ATTENTION_REQUIRED";
  error: string | null;
  postMergeError: string | null;
};

type Batch = {
  id: string;
  status: "ACTIVE" | "COMPLETED";
  items: BatchItem[];
  createdAt: string;
  updatedAt: string;
};

type Scope = { appId: string | null; agentId: string | null };

const REQUEST_FIELDS = `
  worktreeId repositoryName agentName branch folder provider
  requestKey requestNumber requestTitle requestUrl
`;
const CANDIDATE_FIELDS = `
  ${REQUEST_FIELDS}
  repositoryNameWithOwner projectId reviewedHeadSha reviewedTargetBranch blockedReason
  githubOptions {
    ${MERGE_FOLLOW_UP_FIELDS}
    availableMethods commitEmails defaultCommitEmail defaultCommitHeadline defaultCommitBody canMerge
  }
  gitlabOptions {
    ${BASE_BRANCH_UPDATE_FIELDS} ${POST_MERGE_SWITCH_OPTION_FIELDS}
    worktreeId worktreeFolder canDeleteWorktree ticketKey ticketDoneStatusConfigured
    defaultMoveTicketToDone defaultDeleteWorktree
    mergeMethod squashPolicy squash removeSourceBranch canRemoveSourceBranch canMerge
    mergeCommitMessage squashCommitMessage
  }
`;
const BATCH_FIELDS = `
  id status createdAt updatedAt
  items { ${REQUEST_FIELDS} id status error postMergeError }
`;

function settingsFor(candidate: Candidate): BulkMergeOptions | null {
  if (
    candidate.blockedReason ||
    !candidate.reviewedHeadSha ||
    !candidate.reviewedTargetBranch
  )
    return null;
  if (
    candidate.provider === "GITHUB" &&
    candidate.repositoryNameWithOwner &&
    candidate.githubOptions?.canMerge &&
    candidate.githubOptions.worktreeId === candidate.worktreeId
  )
    return { provider: "GITHUB", options: candidate.githubOptions };
  if (
    candidate.provider === "GITLAB" &&
    candidate.projectId &&
    candidate.gitlabOptions?.canMerge &&
    candidate.gitlabOptions.worktreeId === candidate.worktreeId
  )
    return { provider: "GITLAB", options: candidate.gitlabOptions };
  return null;
}

function candidateVersion(
  candidate: Candidate,
  settings: BulkMergeOptions | null,
) {
  return JSON.stringify([
    candidate.worktreeId,
    candidate.requestKey,
    candidate.reviewedHeadSha,
    candidate.reviewedTargetBranch,
    settings?.options.ticketKey,
    settings?.options.switchToDefaultBranchName,
    settings?.options.baseBranchUpdateOptions?.destinationBaseBranch,
    settings?.provider === "GITLAB" ? settings.options.mergeMethod : null,
  ]);
}

function batchItemInput(
  candidate: Candidate,
  settings: BulkMergeOptions,
  draft: BulkMergeDraft,
) {
  const reviewed = {
    worktreeId: candidate.worktreeId,
    requestKey: candidate.requestKey,
    reviewedHeadSha: candidate.reviewedHeadSha,
    reviewedTargetBranch: candidate.reviewedTargetBranch,
  };
  const followUps = bulkMergeFollowUpInput(settings, draft);
  if (draft.provider === "GITHUB" && settings.provider === "GITHUB") {
    const [owner, name] = candidate.repositoryNameWithOwner!.split("/", 2);
    return {
      ...reviewed,
      github: {
        ...followUps,
        owner,
        name,
        number: candidate.requestNumber,
        method: draft.method,
        commitHeadline: draft.commitHeadline,
        commitBody: draft.commitBody,
        authorEmail: draft.authorEmail,
        worktreeId: candidate.worktreeId,
      },
    };
  }
  if (draft.provider === "GITLAB" && settings.provider === "GITLAB") {
    return {
      ...reviewed,
      gitlab: {
        ...followUps,
        ...bulkMergeGitLabMessages(settings.options, draft),
        projectId: candidate.projectId,
        iid: candidate.requestNumber,
        sha: candidate.reviewedHeadSha,
        worktreeId: candidate.worktreeId,
        squash: draft.squash,
        removeSourceBranch: draft.removeSourceBranch,
        autoMerge: false,
        autoSync: false,
      },
    };
  }
  throw new Error("Bulk Merge settings did not match the request provider.");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function useMergeBatches(scope: Scope, onReload: () => Promise<void>) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<Batch[]>([]);
  const revision = useRef(0);
  const { appId, agentId } = scope;

  const record = useCallback((batch: Batch) => {
    ++revision.current;
    const previous = latest.current.filter(({ id }) => id !== batch.id);
    latest.current = [batch, ...previous];
    setBatches(latest.current);
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++revision.current;
      try {
        const { worktreeMergeBatches: next = [] } = await controlPlaneRequest<{
          worktreeMergeBatches: Batch[];
        }>(
          `query WorktreeMergeBatches($appId: ID, $agentId: ID) {
          worktreeMergeBatches(appId: $appId, agentId: $agentId) { ${BATCH_FIELDS} }
        }`,
          { appId, agentId },
          { signal },
        );
        if (signal?.aborted || current !== revision.current) return;
        const previous = latest.current;
        const visible = new Map(next.map((batch) => [batch.id, batch]));
        // Scoped reads return one completed batch. Older tracked batches can
        // disappear from that list as soon as they finish.
        const recovered = await Promise.allSettled(
          previous
            .filter(({ id, status }) => status === "ACTIVE" && !visible.has(id))
            .map(async ({ id }) => {
              const { worktreeMergeBatch: batch } = await controlPlaneRequest<{
                worktreeMergeBatch: Batch | null;
              }>(
                `query WorktreeMergeBatch($id: ID!) {
                  worktreeMergeBatch(id: $id) { ${BATCH_FIELDS} }
                }`,
                { id },
                { signal },
              );
              if (!batch)
                throw new Error(`Bulk Merge batch ${id} is unavailable.`);
              return batch;
            }),
        );
        if (signal?.aborted || current !== revision.current) return;
        let recoveryError: string | null = null;
        for (const result of recovered) {
          if (result.status === "fulfilled")
            visible.set(result.value.id, result.value);
          else recoveryError ??= errorMessage(result.reason);
        }
        for (const batch of previous)
          if (!visible.has(batch.id)) visible.set(batch.id, batch);
        latest.current = [...visible.values()];
        setBatches(latest.current);
        setError(recoveryError);
        if (
          previous.some(
            ({ id, status }) =>
              status === "ACTIVE" && visible.get(id)?.status === "COMPLETED",
          )
        )
          void onReload().catch(() => undefined);
      } catch (value) {
        if (!signal?.aborted && current === revision.current)
          setError(errorMessage(value));
      }
    },
    [agentId, appId, onReload],
  );

  const activeCount = batches.filter(
    (batch) => batch.status === "ACTIVE",
  ).length;
  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const recovery = onControlPlaneRecovery(
      () => void refresh(controller.signal),
    );
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      recovery();
    };
  }, [refresh]);

  useEffect(() => {
    if (activeCount === 0) return;
    const controller = new AbortController();
    let reading = false;
    const timer = window.setInterval(() => {
      if (reading) return;
      reading = true;
      void refresh(controller.signal).finally(() => {
        reading = false;
      });
    }, 3_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeCount, refresh]);

  return { batches, activeCount, error, record, refresh };
}

export function WorktreeBulkMerge({
  appId,
  agentId,
  disabled,
  onReload,
}: {
  appId?: string;
  agentId: string | null;
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  const t = useTranslations("worktrees.bulkMerge");
  const scope = { appId: appId ?? null, agentId };
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Map<string, BulkMergeDraft>>(
    new Map(),
  );
  const [drafts, setDrafts] = useState<Record<string, BulkMergeDraft>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dialogOpen = useRef(false);
  const candidateRequest = useRef<AbortController | null>(null);
  const submission = useRef<{ requestId: string; fingerprint: string } | null>(
    null,
  );
  const {
    batches,
    activeCount,
    error: progressError,
    record,
    refresh,
  } = useMergeBatches(scope, onReload);

  const activeRequests = new Set(
    batches
      .filter((batch) => batch.status === "ACTIVE")
      .flatMap((batch) =>
        batch.items
          .filter(
            (item) => item.status === "PENDING" || item.status === "SUBMITTING",
          )
          .map(({ requestKey }) => requestKey),
      ),
  );
  const mergedRequests = new Set(
    batches.flatMap((batch) =>
      batch.items
        .filter((item) => item.status === "MERGED")
        .map(({ requestKey }) => requestKey),
    ),
  );
  const rows = candidates.map((candidate) => {
    const settings = settingsFor(candidate);
    const version = candidateVersion(candidate, settings);
    const busy = activeRequests.has(candidate.requestKey);
    const merged = mergedRequests.has(candidate.requestKey);
    const draft = settings
      ? (drafts[version] ??
        selected.get(version) ??
        bulkMergeDefaults(settings))
      : null;
    const ready = Boolean(settings && draft && !busy && !merged);
    return { candidate, version, settings, draft, ready, busy, merged };
  });
  const selectedRows = rows.flatMap(
    ({ ready, version, candidate, settings, draft }) =>
      ready && settings && draft && selected.has(version)
        ? [{ version, candidate, settings, draft }]
        : [],
  );
  const selectedRequests = new Set(
    selectedRows.map(({ candidate }) => candidate.requestKey),
  );
  const readyRequests = new Set(
    rows
      .filter((row) => row.ready)
      .map(({ candidate }) => candidate.requestKey),
  );
  const allSelected =
    readyRequests.size > 0 && selectedRequests.size === readyRequests.size;
  const invalid = selectedRows.some(
    ({ settings, draft }) => !bulkMergeDraftValid(settings, draft),
  );

  useEffect(() => () => candidateRequest.current?.abort(), []);

  const loadCandidates = async () => {
    candidateRequest.current?.abort();
    const controller = new AbortController();
    candidateRequest.current = controller;
    setLoading(true);
    setCandidateError(null);
    try {
      const data = await controlPlaneRequest<{
        worktreeMergeCandidates: Candidate[];
      }>(
        `query WorktreeMergeCandidates($appId: ID, $agentId: ID) {
          worktreeMergeCandidates(appId: $appId, agentId: $agentId) { ${CANDIDATE_FIELDS} }
        }`,
        scope,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        const next = data.worktreeMergeCandidates ?? [];
        const versions = new Set(
          next.map((candidate) =>
            candidateVersion(candidate, settingsFor(candidate)),
          ),
        );
        setCandidates(next);
        setSelected(
          (current) =>
            new Map([...current].filter(([version]) => versions.has(version))),
        );
      }
    } catch (value) {
      if (!controller.signal.aborted) setCandidateError(errorMessage(value));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const changeOpen = (next: boolean) => {
    dialogOpen.current = next;
    setOpen(next);
    if (next) {
      void loadCandidates();
      void refresh();
    } else {
      candidateRequest.current?.abort();
    }
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Map());
      return;
    }
    const chosen = new Set(selectedRequests);
    const next = new Map(
      selectedRows.map(({ version, draft }) => [version, draft]),
    );
    for (const { ready, version, candidate, draft } of rows) {
      if (!ready || !draft || chosen.has(candidate.requestKey)) continue;
      next.set(version, draft);
      chosen.add(candidate.requestKey);
    }
    setSelected(next);
  };

  const start = async () => {
    if (
      disabled ||
      !selectedRows.length ||
      invalid ||
      submitting ||
      loading ||
      candidateError
    )
      return;
    const items = selectedRows.map(({ candidate, settings, draft }) =>
      batchItemInput(candidate, settings, draft),
    );
    const fingerprint = JSON.stringify([scope, items]);
    if (submission.current?.fingerprint !== fingerprint)
      submission.current = { requestId: createClientId(), fingerprint };
    setSubmitting(true);
    setSubmitError(null);
    try {
      const data = await controlPlaneRequest<{
        startWorktreeMergeBatch: Batch;
      }>(
        `mutation StartWorktreeMergeBatch($input: StartWorktreeMergeBatchInput!) {
          startWorktreeMergeBatch(input: $input) { ${BATCH_FIELDS} }
        }`,
        { input: { ...scope, items, requestId: submission.current.requestId } },
      );
      record(data.startWorktreeMergeBatch);
      setSelected(new Map());
      submission.current = null;
      void onReload().catch(() => undefined);
      if (dialogOpen.current) void loadCandidates();
    } catch (value) {
      setSubmitError(errorMessage(value));
      void refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        aria-label={t("button")}
        disabled={disabled && batches.length === 0}
        onClick={() => changeOpen(true)}
        variant="outline"
      >
        {activeCount ? <Spinner aria-hidden="true" /> : <GitMerge />}
        {t("button")}
        {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b p-4 pr-12">
            <DialogTitle>{t("button")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            {submitError && (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
            {progressError && (
              <Alert>
                <AlertDescription>
                  {t("monitoringError")} {progressError}
                </AlertDescription>
              </Alert>
            )}
            {batches.map((batch) => (
              <MergeBatchProgress key={batch.id} batch={batch} />
            ))}
            <section aria-label={t("selection")} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{t("selection")}</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {readyRequests.size > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        submitting || loading || Boolean(candidateError)
                      }
                      onClick={toggleAll}
                    >
                      {t(allSelected ? "deselectAll" : "selectAll")}
                    </Button>
                  )}
                  <Button
                    aria-label={t("refresh")}
                    size="icon-sm"
                    variant="outline"
                    disabled={submitting || loading}
                    onClick={() => {
                      void loadCandidates();
                      void refresh();
                    }}
                  >
                    {loading ? <Spinner /> : <RefreshCw />}
                  </Button>
                </div>
              </div>
              {loading && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("checking")}
                </p>
              )}
              {candidateError && (
                <Alert variant="destructive">
                  <AlertDescription>{candidateError}</AlertDescription>
                </Alert>
              )}
              {!loading && !candidateError && rows.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              )}
              {rows.length > 0 && (
                <ul className="divide-y rounded-lg border">
                  {rows.map(
                    ({
                      candidate,
                      version,
                      settings,
                      draft,
                      ready,
                      busy,
                      merged,
                    }) => {
                      const checked = ready && selected.has(version);
                      return (
                        <MergeCandidateRow
                          key={candidate.worktreeId}
                          candidate={candidate}
                          settings={settings}
                          draft={draft}
                          checked={checked}
                          blockedReason={
                            busy
                              ? t("alreadyRunning")
                              : merged
                                ? t("alreadyMerged")
                                : !ready
                                  ? (candidate.blockedReason ??
                                    t("unavailable"))
                                  : !checked &&
                                      selectedRequests.has(candidate.requestKey)
                                    ? t("duplicate")
                                    : null
                          }
                          disabled={
                            submitting || loading || Boolean(candidateError)
                          }
                          onCheckedChange={(value) =>
                            setSelected((current) => {
                              const next = new Map(current);
                              if (value && draft) next.set(version, draft);
                              else next.delete(version);
                              return next;
                            })
                          }
                          onDraftChange={(next) =>
                            setDrafts((current) => ({
                              ...current,
                              [version]: next,
                            }))
                          }
                        />
                      );
                    },
                  )}
                </ul>
              )}
            </section>
            {selectedRows.length > 0 && (
              <section
                aria-label={t("review")}
                className="space-y-2 rounded-md border p-3"
              >
                <h3 className="font-medium">{t("review")}</h3>
                <ul className="space-y-2">
                  {selectedRows.map(
                    ({ candidate, settings, draft, version }) => (
                      <li key={version} className="break-words text-sm">
                        <span className="font-medium">
                          {candidate.branch} · {candidate.agentName}
                        </span>
                        <MergeFollowUpSummary
                          settings={settings}
                          draft={draft}
                        />
                      </li>
                    ),
                  )}
                </ul>
              </section>
            )}
          </div>
          <DialogFooter className="m-0 shrink-0 flex-col sm:flex-col">
            {invalid && (
              <p role="alert" className="text-sm text-destructive">
                {t("invalidSettings")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("background")}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => changeOpen(false)} variant="outline">
                {t("close")}
              </Button>
              <Button
                disabled={
                  disabled ||
                  loading ||
                  submitting ||
                  invalid ||
                  Boolean(candidateError) ||
                  selectedRows.length === 0
                }
                onClick={() => void start()}
              >
                {submitting && <Spinner />}
                {t("start", { count: selectedRows.length })}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MergeRequestLink({ row }: { row: MergeRequestRow }) {
  const provider = row.provider === "GITHUB" ? "GitHub" : "GitLab";
  const prefix = row.provider === "GITHUB" ? "#" : "!";
  const requestLabel = `${provider} ${prefix}${row.requestNumber}`;
  if (!row.requestUrl)
    return <span className="break-words text-sm">{requestLabel}</span>;
  return (
    <a
      className="break-words text-sm underline-offset-4 hover:underline"
      href={row.requestUrl}
      rel="noreferrer"
      target="_blank"
    >
      {requestLabel}
      {row.requestTitle && ` · ${row.requestTitle}`}
    </a>
  );
}

function MergeCandidateRow({
  candidate,
  settings,
  draft,
  checked,
  blockedReason,
  disabled,
  onCheckedChange,
  onDraftChange,
}: {
  candidate: Candidate;
  settings: BulkMergeOptions | null;
  draft: BulkMergeDraft | null;
  checked: boolean;
  blockedReason: string | null;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  onDraftChange: (draft: BulkMergeDraft) => void;
}) {
  const t = useTranslations("worktrees.bulkMerge");
  const id = useId();
  return (
    <li className="flex items-start gap-3 p-3">
      <Checkbox
        aria-label={t("selectWorktree", { branch: candidate.branch })}
        aria-describedby={`${id}-checkout`}
        checked={checked}
        disabled={disabled || Boolean(blockedReason)}
        id={id}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <Label className="break-all leading-snug" htmlFor={id}>
          {candidate.branch}
        </Label>
        <p
          id={`${id}-checkout`}
          className="break-words text-sm text-muted-foreground"
        >
          {candidate.repositoryName} · {candidate.agentName}
        </p>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {candidate.folder}
        </p>
        <MergeRequestLink row={candidate} />
        {candidate.reviewedTargetBranch && candidate.reviewedHeadSha && (
          <p
            className="break-all font-mono text-xs text-muted-foreground"
            title={candidate.reviewedHeadSha}
          >
            {t("reviewedTarget", {
              branch: candidate.reviewedTargetBranch,
              commit: candidate.reviewedHeadSha.slice(0, 12),
            })}
          </p>
        )}
        {blockedReason && (
          <p className="break-words text-sm text-muted-foreground">
            {blockedReason}
          </p>
        )}
        {settings && draft && !blockedReason && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                className="group px-0"
                size="sm"
                variant="ghost"
                disabled={disabled}
              >
                <ChevronDown className="group-aria-expanded:rotate-180" />
                {t("edit", { branch: candidate.branch })}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <BulkMergeSettings
                row={settings}
                draft={draft}
                onChange={onDraftChange}
                disabled={disabled}
              />
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onDraftChange(bulkMergeDefaults(settings))}
              >
                {t("resetSettings")}
              </Button>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </li>
  );
}

function MergeFollowUpSummary({
  settings,
  draft,
}: {
  settings: BulkMergeOptions;
  draft: BulkMergeDraft;
}) {
  const t = useTranslations("worktrees.bulkMerge");
  const p = useTranslations("pullRequests");
  const g = useTranslations("gitlabPages");
  const actions = [
    draft.deleteWorktree ? p("deleteWorktreeAfterMerge") : null,
    draft.switchToDefaultBranch
      ? p("switchToDefaultBranchAfterMerge", {
          branch: settings.options.switchToDefaultBranchName ?? "",
        })
      : null,
    draft.moveTicketToDone
      ? p("moveTicketToDoneAfterMerge", {
          ticket: settings.options.ticketKey ?? "",
        })
      : null,
    draft.targetingWorktreeIds.length
      ? t("updateTargeting", { count: draft.targetingWorktreeIds.length })
      : null,
    draft.provider === "GITLAB" && draft.removeSourceBranch
      ? g("removeSourceBranch")
      : null,
  ].filter((action): action is string => Boolean(action));
  return (
    <p className="text-muted-foreground">
      {actions.length ? actions.join(" · ") : t("noFollowUps")}
    </p>
  );
}

function MergeBatchProgress({ batch }: { batch: Batch }) {
  const t = useTranslations("worktrees.bulkMerge");
  const completed = batch.items.filter(
    ({ status }) => status !== "PENDING" && status !== "SUBMITTING",
  ).length;
  const progress = t("progress", { completed, total: batch.items.length });
  return (
    <section className="space-y-3 rounded-md border p-3">
      <div role="status" className="space-y-1">
        <h3 className="flex items-center gap-2 font-medium">
          {batch.status === "ACTIVE" && <Spinner aria-hidden="true" />}
          {t(batch.status === "ACTIVE" ? "running" : "completed")}
        </h3>
        <p className="text-sm">{progress}</p>
        <p className="text-xs text-muted-foreground">
          <DateTime value={batch.createdAt} />
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
          <li key={item.id} className="space-y-1 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="break-all font-medium">{item.branch}</p>
              <Badge
                variant={
                  item.status === "MERGED"
                    ? "success"
                    : item.status === "FAILED"
                      ? "destructive"
                      : "outline"
                }
              >
                {t(`status.${item.status}`)}
              </Badge>
            </div>
            <p className="break-words text-sm text-muted-foreground">
              {item.repositoryName} · {item.agentName}
            </p>
            <MergeRequestLink row={item} />
            {item.error && (
              <p className="break-words text-sm text-destructive">
                {item.error}
              </p>
            )}
            {item.postMergeError && (
              <p className="break-words text-sm text-amber-700 dark:text-amber-300">
                {t("postMergeWarning", { message: item.postMergeError })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
