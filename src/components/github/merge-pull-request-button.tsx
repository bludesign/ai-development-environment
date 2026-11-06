"use client";

import { GitMerge, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Link } from "@/i18n/navigation";
import {
  MergeFollowUpFields,
  MERGE_FOLLOW_UP_FIELDS,
} from "./merge-follow-up-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { MergeSyncFields, MergeSyncStatus } from "./merge-sync-fields";
import type {
  GitHubMergeMethod,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestMergeResult,
  GitHubPullRequestView,
  GitHubRequestSource,
} from "@/services/github/types";

import { MergeOperationError } from "./merge-operation-error";
import {
  githubMergeOperationKey,
  reportMergeOperationError,
  runMergeOperation,
  useMergeOperation,
} from "./merge-operation-state";

const DEFAULT_EMAIL = "__github_account_default__";

export function MergePullRequestButton({
  pullRequest,
  onMerged,
  size = "sm",
  variant = "outline",
  className,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  requestSource,
  worktreeId,
}: {
  pullRequest: Pick<
    GitHubPullRequestView,
    "number" | "repositoryNameWithOwner"
  >;
  worktreeId?: string;
  onMerged?: (result: GitHubPullRequestMergeResult) => void | Promise<void>;
  size?: "default" | "sm" | "xs" | "icon" | "icon-sm" | "icon-xs";
  variant?:
    "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  requestSource: GitHubRequestSource;
}) {
  const t = useTranslations("pullRequests");
  const [internalOpen, setInternalOpen] = useState(false);
  const [loadedOptions, setLoadedOptions] = useState<{
    key: string;
    value: GitHubPullRequestMergeOptions;
  } | null>(null);
  const [method, setMethod] = useState<GitHubMergeMethod | "">("");
  const [commitHeadline, setCommitHeadline] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [authorEmail, setAuthorEmail] = useState(DEFAULT_EMAIL);
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<string[]>([]);
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [moveTicketToDone, setMoveTicketToDone] = useState(false);
  const operationKey = githubMergeOperationKey(pullRequest);
  const options =
    loadedOptions?.key === operationKey ? loadedOptions.value : null;
  const mergeOperation = useMergeOperation<GitHubPullRequestMergeResult | null>(
    operationKey,
  );
  const mergedResult = mergeOperation.result?.postMergeError
    ? mergeOperation.result
    : null;
  const merging = mergeOperation.pending;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [owner = "", name = ""] = pullRequest.repositoryNameWithOwner.split(
    "/",
    2,
  );
  const open = controlledOpen ?? internalOpen;
  const currentSheet = useRef({ key: operationKey, open });
  useEffect(() => {
    currentSheet.current = { key: operationKey, open };
    return () => {
      currentSheet.current = { key: "", open: false };
    };
  }, [operationKey, open]);
  const setOpen = (next: boolean) => {
    if (!next) {
      setLoading(false);
      setLoadedOptions(null);
      setError(null);
    }
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setLoadedOptions(null);
      setError(null);
      void controlPlaneRequest<{
        githubPullRequestMergeOptions: GitHubPullRequestMergeOptions;
      }>(
        `query GitHubPullRequestMergeOptions(
          $owner: String!
          $name: String!
          $number: Int!
          $source: GitHubRequestSource!
          $worktreeId: ID
        ) {
          githubPullRequestMergeOptions(
            source: $source
            worktreeId: $worktreeId
            owner: $owner
            name: $name
            number: $number
          ) {
            ${MERGE_FOLLOW_UP_FIELDS}
            availableMethods
            commitEmails
            defaultCommitEmail
            defaultCommitHeadline
            defaultCommitBody
            canMerge
            headRefOid canAutoMergeWithSync autoSyncBlockedReason defaultAutoSync
            autoMergeOperation { autoSync state lastError }
            blockedReason
          }
        }`,
        {
          owner,
          name,
          number: pullRequest.number,
          source: requestSource,
          worktreeId,
        },
      )
        .then((data) => {
          if (!active) return;
          const next = data.githubPullRequestMergeOptions;
          setLoadedOptions({ key: operationKey, value: next });
          setAutoSync(next.defaultAutoSync ?? false);
          setSelectedWorktreeIds(
            next.baseBranchUpdateOptions?.selectedWorktreeIds ?? [],
          );
          setMethod(next.defaultMethod ?? next.availableMethods[0] ?? "");
          setDeleteWorktree(
            Boolean(next.canDeleteWorktree && next.defaultDeleteWorktree),
          );
          setMoveTicketToDone(
            Boolean(next.ticketKey && next.defaultMoveTicketToDone),
          );
          setCommitHeadline(next.defaultCommitHeadline);
          setCommitBody(next.defaultCommitBody);
          setAuthorEmail(next.defaultCommitEmail ?? DEFAULT_EMAIL);
        })
        .catch((value) => {
          if (active)
            setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [
    name,
    open,
    operationKey,
    owner,
    pullRequest.number,
    requestSource,
    worktreeId,
    refresh,
  ]);

  const operation = options?.autoMergeOperation;
  const activeManaged = Boolean(
    operation &&
    ["SYNCING", "WAITING_CI", "WAITING_REQUIREMENTS", "MERGING"].includes(
      operation.state,
    ),
  );

  const merge = async () => {
    if (
      !options ||
      !method ||
      !(autoSync ? options?.canAutoMergeWithSync : options?.canMerge) ||
      !commitHeadline.trim() ||
      mergeOperation.result?.state === "MERGED" ||
      merging ||
      (moveTicketToDone && !options.ticketDoneStatusConfigured)
    )
      return;
    setError(null);
    const outcome =
      await runMergeOperation<GitHubPullRequestMergeResult | null>(
        operationKey,
        autoSync ? "auto" : "merge",
        async () => {
          if (autoSync && options?.worktreeId) {
            await controlPlaneRequest(
              `mutation ConfigureWorktreeAutoMerge($input: ConfigureWorktreeAutoMergeInput!) {
          configureWorktreeAutoMerge(input: $input) { worktreeId state autoSync }
        }`,
              {
                input: {
                  worktreeId: options.worktreeId,
                  repositoryNameWithOwner: pullRequest.repositoryNameWithOwner,
                  pullRequestNumber: pullRequest.number,
                  autoSync: true,
                  expectedHeadSha: options.headRefOid,
                  method,
                  commitHeadline,
                  commitBody,
                  authorEmail:
                    authorEmail === DEFAULT_EMAIL ? null : authorEmail,
                  deleteWorktree,
                  moveTicketToDone,
                  ...(selectedWorktreeIds.length &&
                  options.baseBranchUpdateOptions?.destinationBaseBranch
                    ? {
                        baseBranchUpdate: {
                          worktreeIds: selectedWorktreeIds,
                          destinationBaseBranch:
                            options.baseBranchUpdateOptions
                              .destinationBaseBranch,
                        },
                      }
                    : {}),
                },
              },
            );
            return null;
          }
          const data = await controlPlaneRequest<{
            mergeGitHubPullRequest: GitHubPullRequestMergeResult;
          }>(
            `mutation MergeGitHubPullRequest(
          $input: MergeGitHubPullRequestInput!
          $source: GitHubRequestSource!
        ) {
          mergeGitHubPullRequest(input: $input, source: $source) {
            id state url mergedAt postMergeError ticketKey
          }
        }`,
            {
              input: {
                owner,
                name,
                number: pullRequest.number,
                method,
                commitHeadline,
                commitBody,
                authorEmail: authorEmail === DEFAULT_EMAIL ? null : authorEmail,
                worktreeId: worktreeId ?? options.worktreeId,
                ...(selectedWorktreeIds.length &&
                options?.baseBranchUpdateOptions?.destinationBaseBranch
                  ? {
                      baseBranchUpdate: {
                        worktreeIds: selectedWorktreeIds,
                        destinationBaseBranch:
                          options.baseBranchUpdateOptions.destinationBaseBranch,
                      },
                    }
                  : {}),
                deleteWorktree,
                moveTicketToDone,
              },
              source: requestSource,
            },
          );
          return data.mergeGitHubPullRequest;
        },
        (result) => result?.postMergeError ?? null,
        `${pullRequest.repositoryNameWithOwner} #${pullRequest.number}`,
      );
    if (!outcome) return;
    if (outcome.result) {
      try {
        await onMerged?.(outcome.result);
      } catch (value) {
        reportMergeOperationError(
          operationKey,
          outcome.result,
          t("mergeRefreshFailed", {
            error: value instanceof Error ? value.message : String(value),
          }),
        );
        return;
      }
    }
    if (
      !outcome.result?.postMergeError &&
      currentSheet.current.key === operationKey &&
      currentSheet.current.open
    ) {
      setOpen(false);
    }
  };

  const cancelManaged = async () => {
    if (!options?.worktreeId || merging) return;
    setError(null);
    const outcome = await runMergeOperation(
      operationKey,
      "cancel",
      async () => {
        await controlPlaneRequest(
          `mutation CancelWorktreeAutoMerge($worktreeId: ID!) { cancelWorktreeAutoMerge(worktreeId: $worktreeId) }`,
          { worktreeId: options.worktreeId },
        );
        return null;
      },
      () => null,
      `${pullRequest.repositoryNameWithOwner} #${pullRequest.number}`,
    );
    if (outcome && currentSheet.current.key === operationKey)
      setRefresh((value) => value + 1);
  };

  const displayedError = error ?? mergeOperation.error;
  const backgroundAvailable = merging && mergeOperation.action !== "cancel";
  const blockedReason =
    operation?.lastError ??
    (autoSync ? options?.autoSyncBlockedReason : options?.blockedReason) ??
    null;
  return (
    <>
      {showTrigger && (
        <>
          <Button
            aria-busy={merging}
            className={className}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
            }}
            size={size}
            type="button"
            variant={variant}
          >
            {merging ? <Spinner aria-hidden="true" /> : <GitMerge />}
            {t(merging ? "merging" : "merge")}
          </Button>
        </>
      )}
      {!open && (
        <MergeOperationError
          operationKey={operationKey}
          onOpen={() => setOpen(true)}
        />
      )}
      <Dialog
        onOpenChange={(next) => {
          if (!merging) setOpen(next);
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("mergePullRequest")}</DialogTitle>
            <DialogDescription>
              {t("mergePullRequestDescription", {
                repository: pullRequest.repositoryNameWithOwner,
                number: pullRequest.number,
              })}
            </DialogDescription>
          </DialogHeader>

          {mergedResult ? (
            <Alert>
              <AlertDescription>
                <p>{t("mergedFollowUpFailed")}</p>
                <p>{mergedResult.postMergeError}</p>
                {mergedResult.ticketKey && (
                  <Link
                    className="underline"
                    href={`/jira/tickets/${encodeURIComponent(mergedResult.ticketKey)}`}
                  >
                    {mergedResult.ticketKey}
                  </Link>
                )}
              </AlertDescription>
            </Alert>
          ) : loading || (!options && !error) ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" /> {t("loadingMergeOptions")}
            </div>
          ) : (
            <div className="space-y-4">
              {(displayedError || blockedReason) && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {displayedError || blockedReason}
                  </AlertDescription>
                </Alert>
              )}
              {operation && <MergeSyncStatus state={operation.state} />}
              {options && !activeManaged && (
                <>
                  <MergeSyncFields
                    checked={autoSync}
                    onChange={setAutoSync}
                    disabled={merging}
                    unavailableReason={options.autoSyncBlockedReason}
                  />
                  <div>
                    <Label className="mb-1.5 block" htmlFor="merge-method">
                      {t("mergeType")}
                    </Label>
                    <Select
                      disabled={
                        merging || options.availableMethods.length === 0
                      }
                      onValueChange={(value) =>
                        setMethod(value as GitHubMergeMethod)
                      }
                      value={method}
                    >
                      <SelectTrigger id="merge-method">
                        <SelectValue placeholder={t("selectMergeType")} />
                      </SelectTrigger>
                      <SelectContent>
                        {options.availableMethods.map((value) => (
                          <SelectItem key={value} value={value}>
                            {t(`mergeTypes.${value}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label
                      className="mb-1.5 block"
                      htmlFor="merge-commit-headline"
                    >
                      {t("commitMessage")}
                    </Label>
                    <Input
                      disabled={merging}
                      id="merge-commit-headline"
                      onChange={(event) =>
                        setCommitHeadline(event.target.value)
                      }
                      value={commitHeadline}
                    />
                  </div>
                  <div>
                    <Label className="mb-1.5 block" htmlFor="merge-commit-body">
                      {t("commitDescription")}
                    </Label>
                    <Textarea
                      className="min-h-28"
                      disabled={merging}
                      id="merge-commit-body"
                      onChange={(event) => setCommitBody(event.target.value)}
                      value={commitBody}
                    />
                  </div>
                  <MergeFollowUpFields
                    options={options}
                    selectedWorktreeIds={selectedWorktreeIds}
                    onSelectedWorktreeIdsChange={setSelectedWorktreeIds}
                    disabled={merging}
                    deleteWorktree={deleteWorktree}
                    moveTicketToDone={moveTicketToDone}
                    onDeleteWorktreeChange={setDeleteWorktree}
                    onMoveTicketToDoneChange={setMoveTicketToDone}
                  />
                  <div>
                    <Label className="mb-1.5 block" htmlFor="merge-email">
                      {t("commitEmail")}
                    </Label>
                    <Select
                      disabled={merging}
                      onValueChange={setAuthorEmail}
                      value={authorEmail}
                    >
                      <SelectTrigger id="merge-email">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_EMAIL}>
                          {t("githubDefaultEmail")}
                        </SelectItem>
                        {options.commitEmails.map((email) => (
                          <SelectItem key={email} value={email}>
                            {email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
          )}

          <DialogFooter>
            {operation && (
              <Button
                variant="outline"
                size="icon"
                aria-label={t("refreshMergeOptions")}
                disabled={merging || loading}
                onClick={() => setRefresh((value) => value + 1)}
              >
                <RefreshCw />
              </Button>
            )}
            {operation && operation.state === "ACTION_REQUIRED" && (
              <Button
                variant="destructive"
                disabled={merging}
                onClick={() => void cancelManaged()}
              >
                {t("cancelAutoMerge")}
              </Button>
            )}
            <Button
              disabled={merging}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              {mergedResult ? t("closeMergeResult") : t("cancelMerge")}
            </Button>
            <Button
              disabled={
                !backgroundAvailable &&
                (loading ||
                  merging ||
                  (!activeManaged &&
                    (mergeOperation.result?.state === "MERGED" ||
                      (moveTicketToDone &&
                        !options?.ticketDoneStatusConfigured) ||
                      !(autoSync
                        ? options?.canAutoMergeWithSync
                        : options?.canMerge) ||
                      !method ||
                      !commitHeadline.trim())))
              }
              onClick={() => {
                if (backgroundAvailable) setOpen(false);
                else void (activeManaged ? cancelManaged() : merge());
              }}
              type="button"
            >
              {merging ? <Spinner aria-hidden="true" /> : <GitMerge />}
              {backgroundAvailable
                ? t("continueInBackground")
                : activeManaged
                  ? t("cancelAutoMerge")
                  : autoSync
                    ? t(
                        operation?.state === "ACTION_REQUIRED"
                          ? "resumeAutoMerge"
                          : "enableAutoMerge",
                      )
                    : merging
                      ? t("merging")
                      : t("mergePullRequest")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
