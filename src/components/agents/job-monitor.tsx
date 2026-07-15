"use client";

import { Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import { JOB_FIELDS, JOB_LOG_FIELDS } from "./graphql-fields";
import { StatusBadge } from "./status-badge";
import type { AgentJob, AgentJobLog } from "./types";

export function JobMonitor({
  jobId,
  compact = false,
}: {
  jobId: string;
  compact?: boolean;
}) {
  const t = useTranslations("jobs");
  const [job, setJob] = useState<AgentJob | null>(null);
  const [logs, setLogs] = useState<AgentJobLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const output = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        agentJob: AgentJob | null;
        agentJobLogs: AgentJobLog[];
      }>(
        `query Job($id: ID!) { agentJob(id: $id) { ${JOB_FIELDS} } agentJobLogs(jobId: $id) { ${JOB_LOG_FIELDS} } }`,
        { id: jobId },
      );
      setJob(data.agentJob);
      setLogs(data.agentJobLogs);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const client = controlPlaneSubscriptions();
    const unsubscribeJob = client.subscribe<{ agentJobChanged: AgentJob }>(
      {
        query: `subscription JobChanged($jobId: ID!) { agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} } }`,
        variables: { jobId },
      },
      {
        next: (value) =>
          value.data?.agentJobChanged && setJob(value.data.agentJobChanged),
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
          const log = value.data?.agentJobLogAdded;
          if (!log) return;
          setLogs((current) =>
            current.some((item) => item.sequence === log.sequence)
              ? current
              : [...current, log].sort((a, b) => a.sequence - b.sequence),
          );
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      unsubscribeJob();
      unsubscribeLogs();
      window.clearTimeout(initialLoad);
    };
  }, [jobId, load]);

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
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (loading)
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  if (!job)
    return <p className="text-sm text-muted-foreground">{t("notFound")}</p>;

  return (
    <section
      className={cn(
        "rounded-xl border bg-card shadow-sm",
        compact ? "p-4" : "p-5",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-medium">{job.kind}</h2>
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {job.id}
          </p>
        </div>
        <div className="flex gap-2">
          {compact && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${job.id}`}>{t("open")}</Link>
            </Button>
          )}
          {(job.status === "QUEUED" || job.status === "RUNNING") && (
            <Button
              onClick={() => void cancel()}
              size="sm"
              variant="destructive"
            >
              <Square />
              {t("cancel")}
            </Button>
          )}
        </div>
      </div>
      {job.error && (
        <p className="mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {job.error}
        </p>
      )}
      <div
        ref={output}
        className={cn(
          "mt-4 overflow-auto rounded-lg border bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100",
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
    </section>
  );
}
