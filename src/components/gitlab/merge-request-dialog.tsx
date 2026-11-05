"use client";

import { GitMerge, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  MergeFollowUpFields,
  BASE_BRANCH_UPDATE_FIELDS,
} from "@/components/github/merge-follow-up-fields";
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
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  MergeSyncFields,
  MergeSyncStatus,
} from "@/components/github/merge-sync-fields";
import type {
  GitLabMergeOptions,
  GitLabMergeRequestView,
  GitLabMergeResult,
} from "@/services/gitlab";

import {
  GITLAB_MERGE_OPERATION_FIELDS,
  GITLAB_MERGE_REQUEST_FIELDS,
} from "./merge-request-fields";
import {
  GitLabMergeRequestStateBadge,
  gitLabStatusColors,
} from "./merge-request-status";

import {
  clearMergeOperation,
  gitlabMergeOperationKey,
  reportMergeOperationError,
  runMergeOperation,
  useMergeOperation,
} from "@/components/github/merge-operation-state";

const OPTIONS_FIELDS = `${BASE_BRANCH_UPDATE_FIELDS} projectId iid title state sha sourceBranch targetBranch mergeMethod squashPolicy squash removeSourceBranch
  canRemoveSourceBranch canMerge canAutoMerge canAutoMergeWithSync autoSyncBlockedReason defaultAutoSync canCancelAutoMerge autoMergeEnabled mergeBlockedReason autoMergeBlockedReason
  mergeCommitMessage squashCommitMessage worktreeId worktreeFolder canDeleteWorktree ticketKey ticketDoneStatusConfigured
  defaultMoveTicketToDone defaultDeleteWorktree operation { ${GITLAB_MERGE_OPERATION_FIELDS} }`;
const RESULT_FIELDS = `mergeRequest { ${GITLAB_MERGE_REQUEST_FIELDS} } operation { ${GITLAB_MERGE_OPERATION_FIELDS} } postMergeError ticketTransitionError`;

export function MergeRequestDialog({
  mergeRequest,
  worktreeId,
  onMerged,
  onOpenChange,
  open,
}: {
  mergeRequest: { iid: number; projectId: string; title: string };
  worktreeId?: string | null;
  onMerged?: (mergeRequest: GitLabMergeRequestView) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const t = useTranslations("gitlabPages");
  const tp = useTranslations("pullRequests");
  const id = useId();
  const generation = useRef(0);
  const [loadedOptions, setLoadedOptions] = useState<{
    key: string;
    value: GitLabMergeOptions;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const operationKey = gitlabMergeOperationKey(mergeRequest);
  const options =
    loadedOptions?.key === operationKey ? loadedOptions.value : null;
  const mergeOperation = useMergeOperation<GitLabMergeResult>(operationKey);
  const busy = mergeOperation.pending;
  const result = mergeOperation.result;
  const [error, setError] = useState<string | null>(null);
  const currentSheet = useRef({ key: operationKey, open });
  useEffect(() => {
    currentSheet.current = { key: operationKey, open };
    return () => {
      currentSheet.current = { key: "", open: false };
    };
  }, [operationKey, open]);
  const [squash, setSquash] = useState(false);
  const [removeSourceBranch, setRemoveSourceBranch] = useState(false);
  const [customMerge, setCustomMerge] = useState(false);
  const [customSquash, setCustomSquash] = useState(false);
  const [mergeMessage, setMergeMessage] = useState("");
  const [squashMessage, setSquashMessage] = useState("");
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<string[]>([]);
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [moveTicketToDone, setMoveTicketToDone] = useState(false);
  const [autoSync, setAutoSync] = useState(false);

  const load = useCallback(
    async (replaceOutcome = false) => {
      const current = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const data = await controlPlaneRequest<{
          gitlabMergeRequestMergeOptions: GitLabMergeOptions;
        }>(
          `query GitLabMergeRequestMergeOptions($projectId: ID!, $iid: Int!, $worktreeId: ID) {
          gitlabMergeRequestMergeOptions(projectId: $projectId, iid: $iid, worktreeId: $worktreeId) { ${OPTIONS_FIELDS} }
        }`,
          {
            projectId: mergeRequest.projectId,
            iid: mergeRequest.iid,
            worktreeId: worktreeId ?? null,
          },
        );
        if (generation.current !== current) return;
        const next = data.gitlabMergeRequestMergeOptions;
        setLoadedOptions({ key: operationKey, value: next });
        clearMergeOperation(operationKey, !replaceOutcome);
        setAutoSync(next.defaultAutoSync ?? false);
        setSelectedWorktreeIds(
          next.baseBranchUpdateOptions?.selectedWorktreeIds ?? [],
        );
        setSquash(next.squash);
        setRemoveSourceBranch(next.removeSourceBranch);
        setCustomMerge(next.mergeCommitMessage !== null);
        setCustomSquash(next.squashCommitMessage !== null);
        setMergeMessage(next.mergeCommitMessage ?? "");
        setSquashMessage(next.squashCommitMessage ?? "");
        setDeleteWorktree(next.canDeleteWorktree && next.defaultDeleteWorktree);
        setMoveTicketToDone(
          Boolean(next.ticketKey && next.defaultMoveTicketToDone),
        );
      } catch (value) {
        if (generation.current === current)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (generation.current === current) setLoading(false);
      }
    },
    [mergeRequest.iid, mergeRequest.projectId, operationKey, worktreeId],
  );

  const cancelLoad = useCallback(() => {
    generation.current++;
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setLoadedOptions(null);
      void load();
    }, 0);
    return () => {
      cancelLoad();
      window.clearTimeout(timer);
    };
  }, [cancelLoad, load, open]);

  const operation = result?.operation ?? options?.operation;
  const baseUpdateResults = operation?.baseBranchUpdateResults ?? [];
  const confirmed =
    result?.mergeRequest.state === "MERGED" ||
    options?.state === "MERGED" ||
    Boolean(operation?.mergeConfirmedAt);
  const managedPending = Boolean(
    operation?.autoMerge &&
    !confirmed &&
    ["SYNCING", "WAITING_CI", "WAITING_REQUIREMENTS", "MERGING"].includes(
      operation.state,
    ),
  );
  const autoMergeEnabled =
    managedPending ||
    (result
      ? Boolean(result.mergeRequest.mergeWhenPipelineSucceeds && !confirmed)
      : options?.autoMergeEnabled);
  const mergeMessageApplicable = options?.mergeMethod !== "ff";
  const invalidMessages =
    (mergeMessageApplicable && customMerge && !mergeMessage.trim()) ||
    (squash && customSquash && !squashMessage.trim());
  const invalidFollowUp =
    moveTicketToDone && !options?.ticketDoneStatusConfigured;
  const disabled = busy || loading;
  const method = ["merge", "rebase_merge", "ff"].includes(
    options?.mergeMethod ?? "",
  )
    ? options?.mergeMethod
    : "unknown";

  const perform = async (action: "merge" | "auto" | "cancel" | "retry") => {
    if (disabled || (!options && action !== "cancel" && action !== "retry"))
      return;
    if (
      (action === "merge" || action === "auto") &&
      (confirmed || invalidMessages || invalidFollowUp)
    )
      return;
    setError(null);
    const outcome = await runMergeOperation(
      operationKey,
      action,
      async () => {
        let next: GitLabMergeResult;
        if (action === "cancel" || action === "retry") {
          const field =
            action === "cancel"
              ? "cancelGitLabAutoMerge"
              : "retryGitLabMergeFollowUps";
          const data = await controlPlaneRequest<
            Record<string, GitLabMergeResult>
          >(
            `mutation ${action === "cancel" ? "CancelGitLabAutoMerge" : "RetryGitLabMergeFollowUps"}($projectId: ID!, $iid: Int!) { ${field}(projectId: $projectId, iid: $iid) { ${RESULT_FIELDS} } }`,
            { projectId: mergeRequest.projectId, iid: mergeRequest.iid },
          );
          next = data[field]!;
        } else {
          const reviewedOptions = options!;
          const data = await controlPlaneRequest<{
            submitGitLabMergeRequestMerge: GitLabMergeResult;
          }>(
            `mutation SubmitGitLabMergeRequestMerge($input: SubmitGitLabMergeRequestMergeInput!) { submitGitLabMergeRequestMerge(input: $input) { ${RESULT_FIELDS} } }`,
            {
              input: {
                projectId: reviewedOptions.projectId,
                iid: reviewedOptions.iid,
                sha: reviewedOptions.sha,
                autoMerge: action === "auto",
                ...(action === "auto" && autoSync ? { autoSync: true } : {}),
                squash,
                removeSourceBranch: reviewedOptions.canRemoveSourceBranch
                  ? removeSourceBranch
                  : reviewedOptions.removeSourceBranch,
                mergeCommitMessage:
                  mergeMessageApplicable && customMerge
                    ? mergeMessage.trim()
                    : null,
                squashCommitMessage:
                  squash && customSquash ? squashMessage.trim() : null,
                worktreeId: worktreeId ?? reviewedOptions.worktreeId,
                ...(selectedWorktreeIds.length &&
                reviewedOptions?.baseBranchUpdateOptions?.destinationBaseBranch
                  ? {
                      baseBranchUpdate: {
                        worktreeIds: selectedWorktreeIds,
                        destinationBaseBranch:
                          reviewedOptions.baseBranchUpdateOptions
                            .destinationBaseBranch,
                      },
                    }
                  : {}),
                deleteWorktree,
                moveTicketToDone,
              },
            },
          );
          next = data.submitGitLabMergeRequestMerge;
        }
        return next;
      },
      (next) =>
        next.postMergeError ??
        next.ticketTransitionError ??
        (next.operation?.state === "ACTION_REQUIRED"
          ? next.operation.lastError
          : null),
      `GitLab !${mergeRequest.iid} · ${mergeRequest.title}`,
    );
    if (!outcome) return;
    const next = outcome.result;
    try {
      await onMerged?.(next.mergeRequest);
    } catch (value) {
      reportMergeOperationError(
        operationKey,
        next,
        tp("mergeRefreshFailed", {
          error: value instanceof Error ? value.message : String(value),
        }),
      );
      return;
    }
    if (
      !next.postMergeError &&
      !next.ticketTransitionError &&
      next.operation?.state !== "ACTION_REQUIRED" &&
      currentSheet.current.key === operationKey &&
      currentSheet.current.open
    )
      onOpenChange(false);
  };
  const savedResultError =
    result?.postMergeError ??
    result?.ticketTransitionError ??
    operation?.lastError;
  const displayedError =
    error ??
    (mergeOperation.error !== savedResultError ? mergeOperation.error : null);
  const backgroundAvailable =
    busy && ["merge", "auto"].includes(mergeOperation.action ?? "");

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("mergeOptions")}</DialogTitle>
          <DialogDescription>
            !{mergeRequest.iid} · {options?.title ?? mergeRequest.title}
          </DialogDescription>
        </DialogHeader>
        {displayedError && (
          <Alert variant="destructive">
            <AlertDescription>{displayedError}</AlertDescription>
          </Alert>
        )}
        {(result?.postMergeError ||
          result?.ticketTransitionError ||
          operation?.lastError) && (
          <Alert variant="destructive">
            <AlertDescription>
              {confirmed && <p>{t("mergeFollowUpFailed")}</p>}
              <p>
                {result?.postMergeError ??
                  result?.ticketTransitionError ??
                  operation?.lastError}
              </p>
            </AlertDescription>
          </Alert>
        )}
        {loading && !options ? (
          <div className="flex justify-center py-6">
            <Spinner aria-hidden="true" />
          </div>
        ) : (
          options && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <GitLabMergeRequestStateBadge
                  state={result?.mergeRequest.state ?? options.state}
                />
                {operation && (
                  <Badge
                    className={
                      operation.state === "ACTION_REQUIRED"
                        ? gitLabStatusColors.warning
                        : gitLabStatusColors.neutral
                    }
                  >
                    {t.has(`operationStates.${operation.state}`)
                      ? t(`operationStates.${operation.state}`)
                      : t("unknown")}
                  </Badge>
                )}
              </div>
              <p className="font-mono text-xs break-all text-muted-foreground">
                {options.sourceBranch} → {options.targetBranch} ·{" "}
                {options.sha.slice(0, 8)}
              </p>
              {confirmed ? (
                <p role="status" className="text-sm">
                  {operation?.state === "POST_MERGE"
                    ? t("followUpsPending")
                    : t("mergeCompleted")}
                </p>
              ) : managedPending ? (
                <MergeSyncStatus state={operation?.state} />
              ) : autoMergeEnabled ? (
                <p role="status" className="text-sm">
                  {t("mergeWaiting")}
                </p>
              ) : options.state !== "OPENED" ? (
                <p className="text-sm">{t("mergeRequestClosed")}</p>
              ) : (
                <>
                  <div className="overflow-hidden rounded-lg border">
                    <div className="flex flex-wrap items-center gap-3 bg-muted/30 p-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                        <GitMerge className="size-4" />
                      </div>
                      <div className="min-w-40 flex-1">
                        <p className="text-sm font-medium">
                          {t("mergeMethod")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("projectMergeMethod")}
                        </p>
                      </div>
                      <Badge variant="secondary" className="h-6 px-2.5">
                        {t(`mergeMethods.${method}`)}
                      </Badge>
                    </div>
                    <div className="divide-y border-t">
                      <div className="flex items-start gap-3 p-3">
                        <Checkbox
                          id={`${id}-squash`}
                          aria-label={t("squashCommits")}
                          checked={squash}
                          disabled={
                            disabled ||
                            options.squashPolicy === "always" ||
                            options.squashPolicy === "never"
                          }
                          onCheckedChange={(value) => setSquash(value === true)}
                        />
                        <Label
                          className="cursor-pointer items-start"
                          htmlFor={`${id}-squash`}
                        >
                          <span className="space-y-1">
                            <span className="block">{t("squashCommits")}</span>
                            {["always", "never"].includes(
                              options.squashPolicy,
                            ) && (
                              <span className="block text-xs font-normal text-muted-foreground">
                                {t(
                                  options.squashPolicy === "always"
                                    ? "squashRequired"
                                    : "squashForbidden",
                                )}
                              </span>
                            )}
                          </span>
                        </Label>
                      </div>
                      <div className="flex items-center gap-3 p-3">
                        <Checkbox
                          id={`${id}-source`}
                          checked={removeSourceBranch}
                          disabled={disabled || !options.canRemoveSourceBranch}
                          onCheckedChange={(value) =>
                            setRemoveSourceBranch(value === true)
                          }
                        />
                        <Label
                          className="cursor-pointer"
                          htmlFor={`${id}-source`}
                        >
                          {t("removeSourceBranch")}
                        </Label>
                      </div>
                    </div>
                  </div>
                  {mergeMessageApplicable && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`${id}-custom-merge`}
                          checked={customMerge}
                          disabled={disabled}
                          onCheckedChange={(value) =>
                            setCustomMerge(value === true)
                          }
                        />
                        <Label htmlFor={`${id}-custom-merge`}>
                          {t("customMergeMessage")}
                        </Label>
                      </div>
                      {customMerge && (
                        <Textarea
                          aria-label={t("mergeCommitMessage")}
                          disabled={disabled}
                          value={mergeMessage}
                          onChange={(event) =>
                            setMergeMessage(event.target.value)
                          }
                        />
                      )}
                    </div>
                  )}
                  {squash && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`${id}-custom-squash`}
                          checked={customSquash}
                          disabled={disabled}
                          onCheckedChange={(value) =>
                            setCustomSquash(value === true)
                          }
                        />
                        <Label htmlFor={`${id}-custom-squash`}>
                          {t("customSquashMessage")}
                        </Label>
                      </div>
                      {customSquash && (
                        <Textarea
                          aria-label={t("squashCommitMessage")}
                          disabled={disabled}
                          value={squashMessage}
                          onChange={(event) =>
                            setSquashMessage(event.target.value)
                          }
                        />
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("useProjectMessage")}
                  </p>
                  <MergeSyncFields
                    checked={autoSync}
                    onChange={setAutoSync}
                    disabled={disabled}
                    unavailableReason={options.autoSyncBlockedReason}
                  />
                  <MergeFollowUpFields
                    options={options}
                    selectedWorktreeIds={selectedWorktreeIds}
                    onSelectedWorktreeIdsChange={setSelectedWorktreeIds}
                    disabled={disabled}
                    deleteWorktree={deleteWorktree}
                    moveTicketToDone={moveTicketToDone}
                    onDeleteWorktreeChange={setDeleteWorktree}
                    onMoveTicketToDoneChange={setMoveTicketToDone}
                  />
                  {invalidMessages && (
                    <p role="alert" className="text-sm text-destructive">
                      {t("mergeMessagesRequired")}
                    </p>
                  )}
                  {!autoSync && options.mergeBlockedReason && (
                    <p className="text-sm text-muted-foreground">
                      {options.mergeBlockedReason}
                    </p>
                  )}
                  {!autoSync &&
                    options.autoMergeBlockedReason &&
                    options.autoMergeBlockedReason !==
                      options.mergeBlockedReason && (
                      <p className="text-sm text-muted-foreground">
                        {options.autoMergeBlockedReason}
                      </p>
                    )}
                </>
              )}
            </div>
          )
        )}
        {baseUpdateResults.map((result) => (
          <p
            key={result.worktreeId}
            className="break-all text-xs text-muted-foreground"
          >
            {result.folder}:{" "}
            {tp(
              result.status === "SKIPPED"
                ? "baseUpdateSkipped"
                : "baseUpdateCompleted",
            )}
          </p>
        ))}
        <DialogFooter className="flex-wrap">
          {operation?.autoMerge &&
            operation.state === "ACTION_REQUIRED" &&
            !confirmed && (
              <Button
                variant="destructive"
                disabled={disabled}
                onClick={() => void perform("cancel")}
              >
                {t("cancelAutoMerge")}
              </Button>
            )}
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("close")}
          </Button>
          <Button
            aria-label={t("refreshMergeOptions")}
            disabled={disabled}
            variant="outline"
            size="icon"
            onClick={() => void load(true)}
          >
            <RefreshCw />
          </Button>
          {backgroundAvailable ? (
            <Button onClick={() => onOpenChange(false)}>
              <Spinner aria-hidden="true" />
              {tp("continueInBackground")}
            </Button>
          ) : confirmed && operation?.state === "ACTION_REQUIRED" ? (
            <Button disabled={disabled} onClick={() => void perform("retry")}>
              {busy && <Spinner aria-hidden="true" />}
              {t("retryFollowUps")}
            </Button>
          ) : autoMergeEnabled ? (
            <Button
              disabled={
                disabled ||
                (options ? !options.canCancelAutoMerge : !autoMergeEnabled)
              }
              onClick={() => void perform("cancel")}
            >
              {busy && <Spinner aria-hidden="true" />}
              {t("cancelAutoMerge")}
            </Button>
          ) : (
            !confirmed &&
            options?.state === "OPENED" && (
              <>
                <Button
                  disabled={
                    disabled ||
                    !(autoSync
                      ? options.canAutoMergeWithSync
                      : options.canAutoMerge) ||
                    invalidMessages ||
                    invalidFollowUp
                  }
                  variant="outline"
                  onClick={() => void perform("auto")}
                >
                  {operation?.autoMerge && operation.state === "ACTION_REQUIRED"
                    ? tp("resumeAutoMerge")
                    : t("enableAutoMerge")}
                </Button>
                <Button
                  disabled={
                    disabled ||
                    autoSync ||
                    !options.canMerge ||
                    invalidMessages ||
                    invalidFollowUp
                  }
                  onClick={() => void perform("merge")}
                >
                  {busy ? <Spinner aria-hidden="true" /> : <GitMerge />}
                  {t("mergeNow")}
                </Button>
              </>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
