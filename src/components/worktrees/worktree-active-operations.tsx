"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AgentJob } from "@/components/agents/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";

import type { Worktree } from "./types";
import { worktreeOperationLabel } from "./worktree-operation-label";

const statusLabels: Record<AgentJob["status"], string> = {
  QUEUED: "statusQueued",
  RUNNING: "statusRunning",
  CANCELLING: "statusCancelling",
  SUCCEEDED: "statusSucceeded",
  FAILED: "statusFailed",
  CANCELLED: "statusCancelled",
  TIMED_OUT: "statusTimedOut",
};

function OperationLink({
  job,
  subtle = false,
}: {
  job: AgentJob;
  subtle?: boolean;
}) {
  const t = useTranslations("worktrees.activeOperations");

  return (
    <Link
      className="flex min-h-7 max-w-full min-w-0 items-center gap-1.5 self-center text-xs text-muted-foreground hover:underline"
      data-worktree-navigation-ignore
      href={`/dashboard/jobs/${job.id}`}
      onClick={(event) => event.stopPropagation()}
      title={job.kind}
    >
      <Spinner aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {worktreeOperationLabel(job, t)}
      </span>
      {(!subtle || job.status !== "RUNNING") && (
        <>
          {" "}
          <Badge
            className={
              subtle
                ? "bg-muted/50 font-normal text-muted-foreground"
                : undefined
            }
            variant={subtle ? "secondary" : "default"}
          >
            {t(statusLabels[job.status])}
          </Badge>
        </>
      )}
    </Link>
  );
}

// Only mount the popover while multiple jobs are active, so a completed batch
// cannot leave an open popover behind or reopen one when new jobs arrive.
function OperationsPopover({ jobs }: { jobs: AgentJob[] }) {
  const t = useTranslations("worktrees.activeOperations");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="text-muted-foreground"
          data-worktree-navigation-ignore
          onClick={(event) => event.stopPropagation()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Spinner aria-hidden="true" />
          {t("count", { count: jobs.length })}
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t("title")}
        className="max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1rem))] overflow-y-auto"
        collisionPadding={8}
        data-worktree-navigation-ignore
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="font-medium">{t("title")}</h2>
        <ul className="space-y-3">
          {jobs.map((job) => (
            <li key={job.id}>
              <OperationLink job={job} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function WorktreeActiveOperations({
  worktree,
}: {
  worktree: Pick<Worktree, "activeJobs" | "activeJob">;
}) {
  const jobs =
    worktree.activeJobs ?? (worktree.activeJob ? [worktree.activeJob] : []);

  if (!jobs.length) return null;
  if (jobs.length === 1) return <OperationLink job={jobs[0]} subtle />;
  return <OperationsPopover jobs={jobs} />;
}
