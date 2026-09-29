"use client";

import { GitMerge, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import {
  MergeFollowUpFields,
  MERGE_FOLLOW_UP_FIELDS,
} from "@/components/github/merge-follow-up-fields";
import { MergePullRequestButton } from "@/components/github/merge-pull-request-button";
import { MergeRequestDialog } from "@/components/gitlab/merge-request-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubMergeMethod,
  GitHubPullRequestMergeOptions,
} from "@/services/github/types";

import type {
  Worktree,
  WorktreeAutoMerge,
  WorktreeAutoSync,
  WorktreeQuickAction,
} from "./types";
import { waitForWorktreeJob } from "./worktree-jobs";

const NONE = "__none__";
const DEFAULT_EMAIL = "__github_account_default__";

type AutomationButtonProps = {
  worktree: Worktree;
  conflictWorkflows: WorktreeQuickAction[];
  disabled: boolean;
  onCompleted: () => Promise<void>;
  onError: (error: string | null) => void;
};

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function AutoSyncButton({
  worktree,
  conflictWorkflows,
  disabled,
  onCompleted,
  onError,
}: AutomationButtonProps) {
  const t = useTranslations("worktrees");
  const rule = worktree.autoSync;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forceArmed, setForceArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useWorkflow, setUseWorkflow] = useState(false);
  const [workflowId, setWorkflowId] = useState(NONE);
  const [choice, setChoice] = useState(NONE);
  const selectedWorkflow = useMemo(
    () => conflictWorkflows.find((workflow) => workflow.id === workflowId),
    [conflictWorkflows, workflowId],
  );

  const openDialog = () => {
    setError(null);
    setForceArmed(false);
    setUseWorkflow(Boolean(rule?.conflictWorkflowId));
    setWorkflowId(rule?.conflictWorkflowId ?? NONE);
    setChoice(rule?.conflictWorkflowChoice ?? NONE);
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        configureWorktreeAutoSync: WorktreeAutoSync;
      }>(
        `mutation ConfigureWorktreeAutoSync(
          $input: ConfigureWorktreeAutoSyncInput!
        ) {
          configureWorktreeAutoSync(input: $input) {
            worktreeId state conflictWorkflowId conflictWorkflowChoice
            lastError pauseReason lastSyncedAt updatedAt
          }
        }`,
        {
          input: {
            worktreeId: worktree.id,
            conflictWorkflowId:
              useWorkflow && workflowId !== NONE ? workflowId : null,
            conflictWorkflowChoice:
              useWorkflow && choice !== NONE ? choice : null,
          },
        },
      );
      void data;
      onError(null);
      setOpen(false);
      await onCompleted();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation CancelWorktreeAutoSync($worktreeId: ID!) {
          cancelWorktreeAutoSync(worktreeId: $worktreeId)
        }`,
        { worktreeId: worktree.id },
      );
      onError(null);
      setOpen(false);
      await onCompleted();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  const forceSync = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        forceWorktreeAutoSync: { id: string };
      }>(
        `mutation ForceWorktreeAutoSync($worktreeId: ID!, $requestId: ID!) {
          forceWorktreeAutoSync(worktreeId: $worktreeId, requestId: $requestId) { id }
        }`,
        { worktreeId: worktree.id, requestId: crypto.randomUUID() },
      );
      await waitForWorktreeJob(data.forceWorktreeAutoSync.id);
      onError(null);
      setOpen(false);
      await onCompleted();
    } catch (value) {
      setError(errorMessage(value));
      await onCompleted().catch(() => undefined);
    } finally {
      setForceArmed(false);
      setBusy(false);
    }
  };

  const paused = rule?.state === "PAUSED";
  return (
    <>
      <Button
        className={
          rule && !paused
            ? "bg-emerald-600 text-white hover:bg-emerald-700"
            : undefined
        }
        disabled={disabled && !rule}
        onClick={(event) => {
          event.stopPropagation();
          openDialog();
        }}
        size="sm"
        type="button"
        variant={paused ? "destructive" : rule ? "default" : "outline"}
      >
        <RefreshCw />
        {paused ? t("autoSyncPaused") : rule ? t("autoSyncing") : t("autoSync")}
      </Button>
      <Dialog
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
          if (!next) setForceArmed(false);
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("autoSyncTitle")}</DialogTitle>
            <DialogDescription>{t("autoSyncDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {(error || rule?.lastError) && (
              <Alert variant="destructive">
                <AlertDescription>{error || rule?.lastError}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-start gap-2">
              <Checkbox
                checked={useWorkflow}
                disabled={busy || conflictWorkflows.length === 0}
                id={`auto-sync-workflow-${worktree.id}`}
                onCheckedChange={(checked) => setUseWorkflow(Boolean(checked))}
              />
              <Label htmlFor={`auto-sync-workflow-${worktree.id}`}>
                {t("useConflictWorkflow")}
              </Label>
            </div>
            {useWorkflow && (
              <>
                <div>
                  <Label className="mb-1.5 block">
                    {t("selectConflictWorkflow")}
                  </Label>
                  <Select
                    disabled={busy}
                    onValueChange={(value) => {
                      setWorkflowId(value);
                      setChoice(NONE);
                    }}
                    value={workflowId}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("noWorkflow")}</SelectItem>
                      {conflictWorkflows.map((workflow) => (
                        <SelectItem key={workflow.id} value={workflow.id}>
                          {workflow.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {selectedWorkflow?.triggerChoices &&
                  selectedWorkflow.triggerChoices.length > 0 && (
                    <div>
                      <Label className="mb-1.5 block">
                        {t("conflictWorkflowChoice")}
                      </Label>
                      <Select
                        disabled={busy}
                        onValueChange={setChoice}
                        value={choice}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedWorkflow.hasPlainTrigger && (
                            <SelectItem value={NONE}>
                              {t("defaultWorkflowTrigger")}
                            </SelectItem>
                          )}
                          {selectedWorkflow.triggerChoices.map((option) => (
                            <SelectItem key={option.key} value={option.key}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
              </>
            )}
          </div>
          <DialogFooter>
            {rule?.state === "PAUSED" &&
              rule.pauseReason === "PREPARATION_CONFLICT" && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (forceArmed) void forceSync();
                    else setForceArmed(true);
                  }}
                  type="button"
                  variant="destructive"
                >
                  {busy && <Spinner />}{" "}
                  {t(
                    forceArmed
                      ? "confirmForceSyncPreparations"
                      : "forceSyncPreparations",
                  )}
                </Button>
              )}
            {rule && (
              <Button
                disabled={busy}
                onClick={() => void cancel()}
                type="button"
                variant="destructive"
              >
                {t("cancelAutoSync")}
              </Button>
            )}
            <Button
              disabled={busy}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={
                busy ||
                (useWorkflow && workflowId === NONE) ||
                Boolean(
                  useWorkflow &&
                  selectedWorkflow?.triggerChoices?.length &&
                  !selectedWorkflow.hasPlainTrigger &&
                  choice === NONE,
                )
              }
              onClick={() => void save()}
              type="button"
            >
              {busy && <Spinner />}
              {paused ? t("resumeAutoSync") : t("saveAutoSync")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function directlyMergeable(worktree: Worktree): boolean {
  const pullRequest = worktree.pullRequest;
  if (
    !pullRequest ||
    pullRequest.state !== "OPEN" ||
    pullRequest.isDraft ||
    pullRequest.mergeable !== "MERGEABLE"
  ) {
    return false;
  }
  return ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(
    pullRequest.mergeStateStatus,
  );
}

export function AutoMergeButton(props: AutomationButtonProps) {
  return props.worktree.sourceControlRequest?.provider === "GITLAB" ? (
    <GitLabAutoMergeButton {...props} />
  ) : (
    <GitHubAutoMergeButton {...props} />
  );
}

function GitLabAutoMergeButton({
  worktree,
  disabled,
  onCompleted,
}: AutomationButtonProps) {
  const t = useTranslations("gitlabPages");
  const [open, setOpen] = useState(false);
  const request = worktree.sourceControlRequest;
  if (!request?.projectId) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <GitMerge />
        {t("mergeOptions")}
      </Button>
      <MergeRequestDialog
        mergeRequest={{
          projectId: request.projectId,
          iid: request.number,
          title: request.title,
        }}
        worktreeId={worktree.id}
        onMerged={onCompleted}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function GitHubAutoMergeButton({
  worktree,
  disabled,
  onCompleted,
  onError,
}: AutomationButtonProps) {
  const t = useTranslations("worktrees");
  const tp = useTranslations("pullRequests");
  const pullRequest = worktree.pullRequest;
  const rule = worktree.autoMerge;
  const currentRule =
    rule &&
    (!pullRequest ||
      (rule.pullRequestNumber === pullRequest.number &&
        rule.repositoryNameWithOwner.toLowerCase() ===
          pullRequest.repositoryNameWithOwner.toLowerCase()))
      ? rule
      : null;
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const repositoryName = pullRequest?.repositoryNameWithOwner;
  const pullRequestNumber = pullRequest?.number;
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<GitHubPullRequestMergeOptions | null>(
    null,
  );
  const [method, setMethod] = useState<GitHubMergeMethod | "">("");
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [authorEmail, setAuthorEmail] = useState(DEFAULT_EMAIL);
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [moveTicketToDone, setMoveTicketToDone] = useState(false);

  useEffect(() => {
    if (!open || !repositoryName || !pullRequestNumber) return;
    let active = true;
    const [owner = "", name = ""] = repositoryName.split("/", 2);
    const timer = window.setTimeout(() => {
      setLoading(true);
      setOptions(null);
      setError(null);
      void controlPlaneRequest<{
        githubPullRequestMergeOptions: GitHubPullRequestMergeOptions;
      }>(
        `query GitHubPullRequestMergeOptions(
        $owner: String!
        $name: String!
        $number: Int!
        $worktreeId: ID
      ) {
        githubPullRequestMergeOptions(
          source: WORKTREE_AUTOMATION
          worktreeId: $worktreeId
          owner: $owner
          name: $name
          number: $number
        ) {
          ${MERGE_FOLLOW_UP_FIELDS}
          availableMethods commitEmails defaultCommitEmail
          defaultCommitHeadline defaultCommitBody canMerge
          canEnableAutoMerge autoMergeEnabled viewerCanDisableAutoMerge
          mergeStateStatus headRefOid blockedReason
        }
      }`,
        { owner, name, number: pullRequestNumber, worktreeId: worktree.id },
      )
        .then((data) => {
          if (!active) return;
          const next = data.githubPullRequestMergeOptions;
          setOptions(next);
          setMethod(next.defaultMethod ?? next.availableMethods[0] ?? "");
          setHeadline(next.defaultCommitHeadline);
          setBody(next.defaultCommitBody);
          setAuthorEmail(next.defaultCommitEmail ?? DEFAULT_EMAIL);
          setDeleteWorktree(
            Boolean(next.canDeleteWorktree && next.defaultDeleteWorktree),
          );
          setMoveTicketToDone(
            Boolean(next.ticketKey && next.defaultMoveTicketToDone),
          );
        })
        .catch((value) => active && setError(errorMessage(value)))
        .finally(() => active && setLoading(false));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, repositoryName, pullRequestNumber, worktree.id]);

  if (
    pullRequest &&
    (manualOpen ||
      (!open &&
        currentRule?.state !== "COMPLETED" &&
        directlyMergeable(worktree)))
  ) {
    return (
      <MergePullRequestButton
        onMerged={() => onCompleted()}
        onOpenChange={setManualOpen}
        open={manualOpen}
        worktreeId={worktree.id}
        pullRequest={pullRequest}
        requestSource="WORKTREE_AUTOMATION"
      />
    );
  }

  const postMerge = pullRequest?.state === "MERGED" && Boolean(currentRule);

  const save = async () => {
    if (
      !pullRequest ||
      !method ||
      !headline.trim() ||
      (!postMerge && moveTicketToDone && !options?.ticketDoneStatusConfigured)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      if (postMerge) {
        await controlPlaneRequest(
          `mutation RetryWorktreeAutoMerge($worktreeId: ID!) {
          retryWorktreeAutoMerge(worktreeId: $worktreeId) { worktreeId state }
        }`,
          { worktreeId: worktree.id },
        );
        onError(null);
        setOpen(false);
        await onCompleted();
        return;
      }
      await controlPlaneRequest<{
        configureWorktreeAutoMerge: WorktreeAutoMerge;
      }>(
        `mutation ConfigureWorktreeAutoMerge(
          $input: ConfigureWorktreeAutoMergeInput!
        ) {
          configureWorktreeAutoMerge(input: $input) {
            worktreeId state repositoryNameWithOwner pullRequestNumber
            mergeMethod commitHeadline commitBody authorEmail deleteWorktree
            moveTicketToDone ticketKey lastError updatedAt
          }
        }`,
        {
          input: {
            worktreeId: worktree.id,
            repositoryNameWithOwner: pullRequest.repositoryNameWithOwner,
            pullRequestNumber: pullRequest.number,
            method,
            commitHeadline: headline,
            commitBody: body,
            authorEmail: authorEmail === DEFAULT_EMAIL ? null : authorEmail,
            deleteWorktree,
            moveTicketToDone,
          },
        },
      );
      onError(null);
      setOpen(false);
      await onCompleted();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation CancelWorktreeAutoMerge($worktreeId: ID!) {
          cancelWorktreeAutoMerge(worktreeId: $worktreeId)
        }`,
        { worktreeId: worktree.id },
      );
      onError(null);
      setOpen(false);
      await onCompleted();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  const paused = currentRule?.state === "ACTION_REQUIRED";
  const completed = currentRule?.state === "COMPLETED";
  return (
    <>
      <Button
        className={
          currentRule && !paused
            ? "bg-emerald-600 text-white hover:bg-emerald-700"
            : undefined
        }
        disabled={!pullRequest || (disabled && !currentRule) || completed}
        onClick={(event) => {
          event.stopPropagation();
          setLoading(true);
          setOptions(null);
          setError(null);
          setOpen(true);
        }}
        size="sm"
        type="button"
        variant={paused ? "destructive" : currentRule ? "default" : "outline"}
      >
        <GitMerge />
        {completed
          ? t("autoMergeComplete")
          : paused
            ? t("autoMergePaused")
            : currentRule
              ? t("autoMerging")
              : t("autoMerge")}
      </Button>
      <Dialog onOpenChange={(next) => !busy && setOpen(next)} open={open}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("autoMergeTitle")}</DialogTitle>
            <DialogDescription>{t("autoMergeDescription")}</DialogDescription>
          </DialogHeader>
          {loading || (!options && !error) ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner /> {tp("loadingMergeOptions")}
            </div>
          ) : (
            <div className="space-y-4">
              {(error || currentRule?.lastError) && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {error || currentRule?.lastError}
                  </AlertDescription>
                </Alert>
              )}
              {options && (
                <>
                  <div>
                    <Label className="mb-1.5 block">{tp("mergeType")}</Label>
                    <Select
                      disabled={busy || postMerge}
                      onValueChange={(value) =>
                        setMethod(value as GitHubMergeMethod)
                      }
                      value={method}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {options.availableMethods.map((value) => (
                          <SelectItem key={value} value={value}>
                            {tp(`mergeTypes.${value}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-1.5 block">
                      {tp("commitMessage")}
                    </Label>
                    <Input
                      disabled={busy || postMerge}
                      onChange={(event) => setHeadline(event.target.value)}
                      value={headline}
                    />
                  </div>
                  <div>
                    <Label className="mb-1.5 block">
                      {tp("commitDescription")}
                    </Label>
                    <Textarea
                      className="min-h-24"
                      disabled={busy || postMerge}
                      onChange={(event) => setBody(event.target.value)}
                      value={body}
                    />
                  </div>
                  <div>
                    <Label className="mb-1.5 block">{tp("commitEmail")}</Label>
                    <Select
                      disabled={busy || postMerge}
                      onValueChange={setAuthorEmail}
                      value={authorEmail}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_EMAIL}>
                          {tp("githubDefaultEmail")}
                        </SelectItem>
                        {options.commitEmails.map((email) => (
                          <SelectItem key={email} value={email}>
                            {email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <MergeFollowUpFields
                    options={options}
                    disabled={busy || postMerge}
                    deleteWorktree={deleteWorktree}
                    moveTicketToDone={moveTicketToDone}
                    onDeleteWorktreeChange={setDeleteWorktree}
                    onMoveTicketToDoneChange={setMoveTicketToDone}
                  />
                </>
              )}
            </div>
          )}
          <DialogFooter>
            {currentRule && (
              <Button
                disabled={busy}
                onClick={() => void cancel()}
                type="button"
                variant="destructive"
              >
                {t("cancelAutoMerge")}
              </Button>
            )}
            <Button
              disabled={busy}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={
                loading ||
                busy ||
                !method ||
                !headline.trim() ||
                (!postMerge &&
                  moveTicketToDone &&
                  !options?.ticketDoneStatusConfigured) ||
                (!currentRule && !options?.canEnableAutoMerge)
              }
              onClick={() => void save()}
              type="button"
            >
              {busy && <Spinner />}
              {paused ? t("resumeAutoMerge") : t("saveAutoMerge")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
