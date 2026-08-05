"use client";

import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link } from "@/i18n/navigation";

import { useWorkflowLabels } from "./workflow-labels";
import type { WorkflowAttempt, WorkflowRun, WorkflowWait } from "./types";

/**
 * The two ways a run can sit still, side by side.
 *
 * A *parked* step handed work to something outside the runtime — an agent job,
 * a plan or session, a build — and holds no leases while it waits; it resumes
 * on its own when that work reports back. A *held* step is the opposite
 * problem: it wanted a codebase or worktree that another run had, so it never
 * started and is being re-dispatched every tick. Both render as "waiting" in
 * the status badge, but only one of them is anybody's fault, so the card labels
 * them separately.
 */

/** Phases `holdForBusyCodebase` and the worktree scheduler stamp on held steps. */
const HELD_PHASES = new Set(["WAITING_FOR_RESOURCE", "WAITING_FOR_WORKTREE"]);

/** Attempt statuses that mean the runtime is still going to dispatch the step. */
const LIVE_ATTEMPT_STATUSES = new Set(["PENDING", "READY", "RUNNING"]);

function stepName(run: WorkflowRun, attemptId: string): string {
  const attempt = run.attempts.find(({ id }) => id === attemptId);
  if (!attempt) return attemptId;
  const node = run.version.definition.nodes.find(
    ({ id }) => id === attempt.nodeId,
  );
  return node?.name || attempt.nodeId;
}

/**
 * The resource link the parked step recorded for the same external id.
 *
 * `parkAttempt` writes the link and the wait in one transaction, so a wait with
 * an `externalKey` almost always has a link carrying a resolved label and URL —
 * which is what turns "waiting for agent job" into a click through to the job.
 */
function waitTarget(run: WorkflowRun, wait: WorkflowWait) {
  if (!wait.externalKey) return null;
  const links = [
    ...run.resourceLinks,
    ...run.attempts.flatMap(({ resourceLinks }) => resourceLinks),
  ];
  return (
    links.find(({ resourceId }) => resourceId === wait.externalKey) ?? null
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

function ParkedStep({ run, wait }: { run: WorkflowRun; wait: WorkflowWait }) {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
  const target = waitTarget(run, wait);

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{stepName(run, wait.attemptId)}</span>
        <Badge variant="outline">{labels.waitKind(wait.kind)}</Badge>
      </div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t("waitTarget")}>
          {target?.url ? (
            <Link className="hover:underline" href={target.url}>
              {target.label ?? wait.externalKey}
            </Link>
          ) : (
            <span className="font-mono text-xs">{wait.externalKey ?? "—"}</span>
          )}
        </Field>
        <Field label={t("waitSince")}>
          <DateTime kind="relative" value={wait.createdAt} />
        </Field>
        <Field label={t("waitTimeout")}>
          {wait.timeoutAt ? (
            <DateTime kind="relative" value={wait.timeoutAt} />
          ) : (
            t("waitNoTimeout")
          )}
        </Field>
        <Field label={t("waitNextCheck")}>
          {wait.resumeAfter ? (
            <DateTime kind="relative" value={wait.resumeAfter} />
          ) : (
            "—"
          )}
        </Field>
      </dl>
    </div>
  );
}

function HeldStep({
  attempt,
  run,
}: {
  attempt: WorkflowAttempt;
  run: WorkflowRun;
}) {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
  const node = run.version.definition.nodes.find(
    ({ id }) => id === attempt.nodeId,
  );

  return (
    <div className="rounded-md border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{node?.name || attempt.nodeId}</span>
        <Badge variant="secondary">{labels.phase(attempt.phase)}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {attempt.error ?? t("waitHeldDescription")}
      </p>
    </div>
  );
}

export function WorkflowWaitCard({ run }: { run: WorkflowRun }) {
  const t = useTranslations("workflows");
  const parked = (run.waits ?? []).filter(({ status }) => status === "PENDING");
  // A held attempt keeps its phase after the run ends — cancelling a run leaves
  // the step it was holding stamped `WAITING_FOR_RESOURCE` — so the live
  // statuses, not the phase alone, decide whether it is still waiting.
  const held = run.attempts.filter(
    ({ phase, status }) =>
      HELD_PHASES.has(phase) && LIVE_ATTEMPT_STATUSES.has(status),
  );
  if (!parked.length && !held.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("waitingOn")}</CardTitle>
        <CardDescription>{t("waitingOnDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {parked.map((wait) => (
          <ParkedStep key={wait.id} run={run} wait={wait} />
        ))}
        {held.map((attempt) => (
          <HeldStep attempt={attempt} key={attempt.id} run={run} />
        ))}
      </CardContent>
    </Card>
  );
}
