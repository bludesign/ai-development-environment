"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { MergeFollowUpFields } from "@/components/github/merge-follow-up-fields";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  GitHubMergeMethod,
  GitHubPullRequestMergeOptions,
} from "@/services/github/types";
import type { GitLabMergeOptions } from "@/services/gitlab/types";

type FollowUps = {
  deleteWorktree: boolean;
  moveTicketToDone: boolean;
  switchToDefaultBranch: boolean;
  targetingWorktreeIds: string[];
};

type GitHubDraft = {
  provider: "GITHUB";
  method: GitHubMergeMethod | "";
  commitHeadline: string;
  commitBody: string;
  authorEmail: string | null;
};

type GitLabDraft = {
  provider: "GITLAB";
  squash: boolean;
  removeSourceBranch: boolean;
  mergeCommitMessage: string | null;
  squashCommitMessage: string | null;
};

export type BulkMergeDraft = FollowUps & (GitHubDraft | GitLabDraft);
export type BulkMergeOptions =
  | { provider: "GITHUB"; options: GitHubPullRequestMergeOptions }
  | { provider: "GITLAB"; options: GitLabMergeOptions };

export function bulkMergeDefaults({
  provider,
  options,
}: BulkMergeOptions): BulkMergeDraft {
  const followUps: FollowUps = {
    deleteWorktree: Boolean(
      options.canDeleteWorktree && options.defaultDeleteWorktree,
    ),
    moveTicketToDone: Boolean(
      options.ticketKey &&
      options.ticketDoneStatusConfigured &&
      options.defaultMoveTicketToDone,
    ),
    switchToDefaultBranch: Boolean(
      options.canSwitchToDefaultBranch && options.defaultSwitchToDefaultBranch,
    ),
    targetingWorktreeIds: options.baseBranchUpdateOptions?.destinationBaseBranch
      ? options.baseBranchUpdateOptions.selectedWorktreeIds.filter((id) =>
          options.baseBranchUpdateOptions?.worktrees.some(
            (worktree) => worktree.id === id && worktree.canUpdate,
          ),
        )
      : [],
  };
  if (provider === "GITHUB") {
    return {
      ...followUps,
      provider,
      method: options.defaultMethod ?? options.availableMethods[0] ?? "",
      commitHeadline: options.defaultCommitHeadline,
      commitBody: options.defaultCommitBody,
      authorEmail: options.defaultCommitEmail,
    };
  }
  return {
    ...followUps,
    provider,
    squash: options.squash,
    removeSourceBranch: options.removeSourceBranch,
    mergeCommitMessage: options.mergeCommitMessage,
    squashCommitMessage: options.squashCommitMessage,
  };
}

function gitLabMergeMessageApplicable(options: GitLabMergeOptions) {
  return options.mergeMethod !== "ff";
}

export function bulkMergeDraftValid(
  row: BulkMergeOptions,
  draft: BulkMergeDraft,
): boolean {
  const { options } = row;
  if (
    (draft.deleteWorktree && !options.canDeleteWorktree) ||
    (draft.switchToDefaultBranch && !options.canSwitchToDefaultBranch) ||
    (draft.moveTicketToDone && !options.ticketDoneStatusConfigured) ||
    draft.targetingWorktreeIds.some(
      (id) =>
        !options.baseBranchUpdateOptions?.destinationBaseBranch ||
        !options.baseBranchUpdateOptions.worktrees.some(
          (worktree) => worktree.id === id && worktree.canUpdate,
        ),
    )
  )
    return false;
  if (row.provider === "GITHUB" && draft.provider === "GITHUB") {
    return Boolean(
      draft.method &&
      row.options.availableMethods.includes(draft.method) &&
      draft.commitHeadline.trim() &&
      (!draft.authorEmail ||
        row.options.commitEmails.includes(draft.authorEmail)),
    );
  }
  if (row.provider === "GITLAB" && draft.provider === "GITLAB") {
    return (
      (row.options.squashPolicy !== "always" || draft.squash) &&
      (row.options.squashPolicy !== "never" || !draft.squash) &&
      (row.options.canRemoveSourceBranch ||
        draft.removeSourceBranch === row.options.removeSourceBranch) &&
      (!gitLabMergeMessageApplicable(row.options) ||
        draft.mergeCommitMessage === null ||
        Boolean(draft.mergeCommitMessage.trim())) &&
      (!draft.squash ||
        draft.squashCommitMessage === null ||
        Boolean(draft.squashCommitMessage.trim()))
    );
  }
  return false;
}

export function bulkMergeFollowUpInput(
  row: BulkMergeOptions,
  draft: BulkMergeDraft,
) {
  const destinationBaseBranch =
    row.options.baseBranchUpdateOptions?.destinationBaseBranch;
  return {
    deleteWorktree: draft.deleteWorktree,
    moveTicketToDone: draft.moveTicketToDone,
    switchToDefaultBranch: draft.switchToDefaultBranch,
    ...(draft.targetingWorktreeIds.length && destinationBaseBranch
      ? {
          baseBranchUpdate: {
            worktreeIds: draft.targetingWorktreeIds,
            destinationBaseBranch,
          },
        }
      : {}),
  };
}

export function bulkMergeGitLabMessages(
  options: GitLabMergeOptions,
  draft: GitLabDraft,
) {
  return {
    mergeCommitMessage: gitLabMergeMessageApplicable(options)
      ? (draft.mergeCommitMessage?.trim() ?? null)
      : null,
    squashCommitMessage: draft.squash
      ? (draft.squashCommitMessage?.trim() ?? null)
      : null,
  };
}

export function BulkMergeSettings({
  row,
  draft,
  onChange,
  disabled,
}: {
  row: BulkMergeOptions;
  draft: BulkMergeDraft;
  onChange: (draft: BulkMergeDraft) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-4 rounded-md border p-3">
      {row.provider === "GITHUB" && draft.provider === "GITHUB" && (
        <GitHubSettings
          options={row.options}
          draft={draft}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {row.provider === "GITLAB" && draft.provider === "GITLAB" && (
        <GitLabSettings
          options={row.options}
          draft={draft}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      <MergeFollowUpFields
        options={row.options}
        selectedWorktreeIds={draft.targetingWorktreeIds}
        onSelectedWorktreeIdsChange={(targetingWorktreeIds) =>
          onChange({ ...draft, targetingWorktreeIds })
        }
        disabled={disabled}
        deleteWorktree={draft.deleteWorktree}
        onDeleteWorktreeChange={(deleteWorktree) =>
          onChange({ ...draft, deleteWorktree })
        }
        moveTicketToDone={draft.moveTicketToDone}
        onMoveTicketToDoneChange={(moveTicketToDone) =>
          onChange({ ...draft, moveTicketToDone })
        }
        switchToDefaultBranch={draft.switchToDefaultBranch}
        onSwitchToDefaultBranchChange={(switchToDefaultBranch) =>
          onChange({ ...draft, switchToDefaultBranch })
        }
      />
    </div>
  );
}

const DEFAULT_EMAIL = "__github_account_default__";

function GitHubSettings({
  options,
  draft,
  onChange,
  disabled,
}: {
  options: GitHubPullRequestMergeOptions;
  draft: FollowUps & GitHubDraft;
  onChange: (draft: BulkMergeDraft) => void;
  disabled: boolean;
}) {
  const t = useTranslations("pullRequests");
  const id = useId();
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-method`}>{t("mergeType")}</Label>
        <Select
          disabled={disabled}
          value={draft.method}
          onValueChange={(method) =>
            onChange({ ...draft, method: method as GitHubMergeMethod })
          }
        >
          <SelectTrigger id={`${id}-method`}>
            <SelectValue placeholder={t("selectMergeType")} />
          </SelectTrigger>
          <SelectContent>
            {options.availableMethods.map((method) => (
              <SelectItem key={method} value={method}>
                {t(`mergeTypes.${method}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-headline`}>{t("commitMessage")}</Label>
        <Input
          id={`${id}-headline`}
          value={draft.commitHeadline}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, commitHeadline: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-body`}>{t("commitDescription")}</Label>
        <Textarea
          id={`${id}-body`}
          value={draft.commitBody}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, commitBody: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-email`}>{t("commitEmail")}</Label>
        <Select
          value={draft.authorEmail ?? DEFAULT_EMAIL}
          disabled={disabled}
          onValueChange={(email) =>
            onChange({
              ...draft,
              authorEmail: email === DEFAULT_EMAIL ? null : email,
            })
          }
        >
          <SelectTrigger id={`${id}-email`}>
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
    </div>
  );
}

function GitLabSettings({
  options,
  draft,
  onChange,
  disabled,
}: {
  options: GitLabMergeOptions;
  draft: FollowUps & GitLabDraft;
  onChange: (draft: BulkMergeDraft) => void;
  disabled: boolean;
}) {
  const t = useTranslations("gitlabPages");
  const id = useId();
  const fixedSquash =
    options.squashPolicy === "always" || options.squashPolicy === "never";
  const method =
    options.mergeMethod === "rebase_merge" || options.mergeMethod === "ff"
      ? options.mergeMethod
      : "merge";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {t("mergeMethod")}
        <Badge variant="secondary">{t(`mergeMethods.${method}`)}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-squash`}
          checked={draft.squash}
          disabled={disabled || fixedSquash}
          onCheckedChange={(value) =>
            onChange({ ...draft, squash: value === true })
          }
        />
        <Label htmlFor={`${id}-squash`}>{t("squashCommits")}</Label>
        {fixedSquash && (
          <span className="text-xs text-muted-foreground">
            {t(
              options.squashPolicy === "always"
                ? "squashRequired"
                : "squashForbidden",
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-source`}
          checked={draft.removeSourceBranch}
          disabled={disabled || !options.canRemoveSourceBranch}
          onCheckedChange={(value) =>
            onChange({ ...draft, removeSourceBranch: value === true })
          }
        />
        <Label htmlFor={`${id}-source`}>{t("removeSourceBranch")}</Label>
      </div>
      {gitLabMergeMessageApplicable(options) && (
        <OptionalMessage
          checkedLabel={t("customMergeMessage")}
          fieldLabel={t("mergeCommitMessage")}
          disabled={disabled}
          value={draft.mergeCommitMessage}
          onChange={(mergeCommitMessage) =>
            onChange({ ...draft, mergeCommitMessage })
          }
        />
      )}
      {draft.squash && (
        <OptionalMessage
          checkedLabel={t("customSquashMessage")}
          fieldLabel={t("squashCommitMessage")}
          disabled={disabled}
          value={draft.squashCommitMessage}
          onChange={(squashCommitMessage) =>
            onChange({ ...draft, squashCommitMessage })
          }
        />
      )}
    </div>
  );
}

function OptionalMessage({
  checkedLabel,
  fieldLabel,
  disabled,
  value,
  onChange,
}: {
  checkedLabel: string;
  fieldLabel: string;
  disabled: boolean;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={value !== null}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked === true ? "" : null)}
        />
        <Label htmlFor={id}>{checkedLabel}</Label>
      </div>
      {value !== null && (
        <Textarea
          aria-label={fieldLabel}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
