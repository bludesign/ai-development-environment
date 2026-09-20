"use client";

import { CircleStop } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";
import { sequenceRanges } from "@/lib/sequence-ranges";
import { cn } from "@/lib/utils";

import { JOB_LOG_FIELDS } from "./graphql-fields";
import { StatusBadge } from "./status-badge";
import type { AgentJob, AgentJobLog } from "./types";

const JOB_FIELDS =
  "id agentId kind status error createdAt startedAt finishedAt updatedAt";

export function JobMonitor({
  jobId,
  compact = false,
  seed,
  onJobChanged,
}: {
  jobId: string;
  compact?: boolean;
  seed?: AgentJob;
  onJobChanged?: (job: AgentJob) => void;
}) {
  const t = useTranslations("jobs");
  const common = useTranslations("common");
  const [loadedJob, setJob] = useState<AgentJob | null>(null);
  const job = seed ?? loadedJob;
  const seeded = Boolean(seed);
  const [logs, setLogs] = useState<AgentJobLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const output = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const logsRef = useRef<AgentJobLog[]>([]);
  const jobRevision = useRef(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRequest = useRef<AbortController | null>(null);
  const mergeLogs = useCallback((incoming: AgentJobLog[]) => {
    const merged = new Map(logsRef.current.map((log) => [log.sequence, log]));
    for (const log of incoming) merged.set(log.sequence, log);
    logsRef.current = [...merged.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    setLogs(logsRef.current);
  }, []);
  const loadOlder = async () => {
    if (olderRequest.current || !logsRef.current.length) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    try {
      const data = await controlPlaneRequest<{ agentJobLogs: AgentJobLog[] }>(
        `query OlderJobLogs($id: ID!, $before: Int!) { agentJobLogs(jobId: $id, beforeSequence: $before, first: 200) { ${JOB_LOG_FIELDS} } }`,
        { id: jobId, before: logsRef.current[0]!.sequence },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      stickToBottom.current = false;
      mergeLogs(data.agentJobLogs);
      setHasOlder(
        data.agentJobLogs.length === 200 && data.agentJobLogs[0]!.sequence > 0,
      );
    } catch (value) {
      if (!controller.signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  };

  useEffect(() => {
    logsRef.current = [];
    let initialized = false;
    const owner = createRefreshCoalescer(async (signal) => {
      const revision = jobRevision.current;
      const initial = !initialized;
      let after = initial ? -1 : (logsRef.current[0]?.sequence ?? 0) - 1;
      try {
        for (;;) {
          const data = await controlPlaneRequest<{
            agentJob?: AgentJob | null;
            agentJobLogs: AgentJobLog[];
          }>(
            `query Job($id: ID!, $metadata: Boolean!, $first: Int!, $latest: Boolean!, $after: Int!, $knownRanges: [AgentJobLogRangeInput!]!) {
              agentJob(id: $id) @include(if: $metadata) { ${JOB_FIELDS} }
              agentJobLogs(jobId: $id, afterSequence: $after, first: $first, latest: $latest, knownRanges: $knownRanges) { ${JOB_LOG_FIELDS} }
            }`,
            {
              id: jobId,
              metadata: !seeded,
              first: initial ? 200 : 5000,
              latest: initial,
              after,
              knownRanges: initial
                ? []
                : sequenceRanges(
                    logsRef.current.map((log) => log.sequence),
                  ).slice(0, 100),
            },
            { signal },
          );
          if (signal.aborted) return;
          if (!seeded && revision === jobRevision.current)
            setJob(data.agentJob ?? null);
          mergeLogs(data.agentJobLogs);
          if (initial)
            setHasOlder(
              Boolean(
                data.agentJobLogs.length && data.agentJobLogs[0]!.sequence > 0,
              ),
            );
          initialized = true;
          if (initial || data.agentJobLogs.length < 5000) break;
          // Continue this reconciliation in sequence order. The next recovery
          // starts from the visible window again to catch late lower sequences.
          const next = data.agentJobLogs.at(-1)!.sequence;
          if (next <= after) break;
          after = next;
        }
        setError(null);
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    const client = controlPlaneSubscriptions();
    const unsubscribeJob = seeded
      ? () => undefined
      : client.subscribe<{ agentJobChanged: AgentJob }>(
          {
            query: `subscription JobChanged($jobId: ID!) { agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} } }`,
            variables: { jobId },
          },
          {
            next: (value) => {
              if (value.data?.agentJobChanged) {
                ++jobRevision.current;
                setJob(value.data.agentJobChanged);
              }
            },
            error: () => undefined,
            complete: () => undefined,
          },
        );
    const unsubscribeLogs = client.subscribe<{ agentJobLogAdded: AgentJobLog }>(
      {
        query: `subscription JobLog($jobId: ID!) { agentJobLogAdded(jobId: $jobId) { ${JOB_LOG_FIELDS} } }`,
        variables: { jobId },
      },
      {
        next: (value) => {
          if (value.data?.agentJobLogAdded)
            mergeLogs([value.data.agentJobLogAdded]);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const recover = () => {
      if (document.visibilityState !== "hidden") void owner.refresh();
    };
    const recovery = onControlPlaneRecovery(recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    const initialLoad = window.setTimeout(() => void owner.refresh(), 0);
    return () => {
      owner.dispose();
      recovery();
      unsubscribeJob();
      unsubscribeLogs();
      olderRequest.current?.abort();
      olderRequest.current = null;
      window.clearTimeout(initialLoad);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [jobId, mergeLogs, seeded]);

  useEffect(() => {
    if (stickToBottom.current) {
      output.current?.scrollTo({ top: output.current.scrollHeight });
    }
  }, [logs]);

  const cancel = async () => {
    try {
      const data = await controlPlaneRequest<{ cancelAgentJob: AgentJob }>(
        `mutation Cancel($jobId: ID!) { cancelAgentJob(jobId: $jobId) { ${JOB_FIELDS} } }`,
        { jobId },
      );
      setJob(data.cancelAgentJob);
      onJobChanged?.(data.cancelAgentJob);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  if (loading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {t("loading")}
      </p>
    );
  if (!job)
    return <p className="text-sm text-muted-foreground">{t("notFound")}</p>;

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {compact ? (
            <h2 className="font-medium">{job.kind}</h2>
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">
              {job.kind}
            </h1>
          )}
          <StatusBadge status={job.status} />
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{job.id}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {compact && (
          <Button asChild size="sm" variant="outline">
            <Link href={`/jobs/${job.id}`}>{t("open")}</Link>
          </Button>
        )}
        {(job.status === "QUEUED" || job.status === "RUNNING") && (
          <Button
            onClick={() => void cancel()}
            size={compact ? "sm" : "default"}
            variant="destructive"
          >
            <CircleStop />
            {t("cancel")}
          </Button>
        )}
      </div>
    </div>
  );

  const body = (
    <>
      {hasOlder && (
        <Button
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
          size="sm"
          variant="outline"
        >
          {loadingOlder && <Spinner />}
          {common("loadMore")}
        </Button>
      )}
      {job.error && (
        <Alert variant="destructive">
          <AlertDescription>{job.error}</AlertDescription>
        </Alert>
      )}
      <div
        ref={output}
        className={cn(
          "overflow-auto rounded-lg border bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100",
          compact ? "h-80" : "h-[32rem]",
        )}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
        }}
      >
        {logs.length === 0 ? (
          <span className="text-zinc-500">{t("waiting")}</span>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className={cn(
                "whitespace-pre-wrap break-all",
                log.stream === "STDERR" && "text-amber-300",
                log.stream === "SYSTEM" && "text-sky-300",
              )}
            >
              <span className="mr-2 select-none text-zinc-600">
                {String(log.sequence).padStart(4, "0")}
              </span>
              {log.message}
            </div>
          ))
        )}
      </div>
    </>
  );

  // Compact instances are embedded inside another page, so the job title stays inside the
  // card. The standalone job page promotes it to the page header the other detail pages use.
  if (compact)
    return (
      <Card className="[--card-spacing:--spacing(4)]">
        <CardContent className="space-y-3">
          {header}
          {body}
        </CardContent>
      </Card>
    );

  return (
    <div className="flex w-full flex-col gap-6">
      {header}
      <Card>
        <CardContent className="space-y-3">{body}</CardContent>
      </Card>
    </div>
  );
}
