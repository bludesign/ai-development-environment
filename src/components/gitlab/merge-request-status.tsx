"use client";

import { useTranslations } from "next-intl";
import {
  CircleHelp,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";

export const gitLabStatusColors = {
  success:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  merged:
    "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300",
  neutral:
    "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

const readinessKeys: Record<string, string> = {
  mergeable: "ready",
  checking: "checking",
  unchecked: "checking",
  preparing: "checking",
  approvals_syncing: "checking",
  ci_must_pass: "pipelineRequired",
  ci_still_running: "pipelineRunning",
  discussions_not_resolved: "discussionsUnresolved",
  not_approved: "approvalRequired",
  requested_changes: "changesRequested",
  draft_status: "draft",
  conflict: "conflicts",
  need_rebase: "rebaseRequired",
  not_open: "notOpen",
  blocked_status: "blocked",
  broken_status: "blocked",
  locked_paths: "blocked",
  locked_lfs_files: "blocked",
  external_status_checks: "externalChecks",
  status_checks_must_pass: "externalChecks",
  security_policy_pipeline_check: "securityChecks",
  security_policy_violations: "securityChecks",
  merge_request_blocked: "blocked",
  merge_time: "scheduled",
  title_regex: "titleInvalid",
};

export function GitLabMergeRequestStateBadge({
  state,
  draft = false,
}: {
  state: string;
  draft?: boolean;
}) {
  const t = useTranslations("gitlabPages");
  const key =
    state === "MERGED"
      ? "merged"
      : state === "CLOSED"
        ? "closed"
        : state === "OPENED"
          ? "open"
          : "unknown";
  const color =
    state === "MERGED"
      ? gitLabStatusColors.merged
      : state === "CLOSED"
        ? gitLabStatusColors.danger
        : state === "OPENED" && !draft
          ? gitLabStatusColors.success
          : gitLabStatusColors.neutral;
  const Icon =
    state === "MERGED"
      ? GitMerge
      : state === "CLOSED"
        ? GitPullRequestClosed
        : state === "OPENED"
          ? GitPullRequest
          : CircleHelp;
  return (
    <Badge className={color}>
      <Icon aria-hidden="true" className="size-3" />
      {t(key)}
    </Badge>
  );
}

export function GitLabMergeReadinessBadge({
  state,
  status,
  hasConflicts = false,
}: {
  state: string;
  status: string;
  hasConflicts?: boolean;
}) {
  const t = useTranslations("gitlabPages");
  if (state !== "OPENED") return null;
  const key = hasConflicts ? "conflicts" : (readinessKeys[status] ?? "unknown");
  const color =
    key === "ready"
      ? gitLabStatusColors.success
      : [
            "conflicts",
            "changesRequested",
            "blocked",
            "securityChecks",
            "titleInvalid",
          ].includes(key)
        ? gitLabStatusColors.danger
        : key === "unknown"
          ? gitLabStatusColors.neutral
          : gitLabStatusColors.warning;
  return <Badge className={color}>{t(`readiness.${key}`)}</Badge>;
}

export function GitLabApprovalBadge({ state }: { state?: string | null }) {
  const t = useTranslations("gitlabPages");
  const known = [
    "APPROVED",
    "REVIEW_REQUIRED",
    "CHANGES_REQUESTED",
    "NOT_REQUIRED",
  ].includes(state ?? "");
  const key = known ? state : "UNKNOWN";
  const color =
    state === "APPROVED"
      ? gitLabStatusColors.success
      : state === "CHANGES_REQUESTED"
        ? gitLabStatusColors.danger
        : state === "REVIEW_REQUIRED"
          ? gitLabStatusColors.warning
          : gitLabStatusColors.neutral;
  return <Badge className={color}>{t(`approvalStates.${key}`)}</Badge>;
}

export function gitLabMergeRequestHref(mr: { projectId: string; iid: number }) {
  return `/gitlab/merge-requests/${encodeURIComponent(mr.projectId)}/${mr.iid}`;
}
