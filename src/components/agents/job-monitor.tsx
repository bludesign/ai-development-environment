"use client";

import { Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import { StatusBadge } from "./status-badge";
import type { AgentJob, AgentJobLog } from "./types";

const JOB_FIELDS = `id agentId kind payload status error result timeoutSeconds createdAt startedAt finishedAt updatedAt`;

export function JobMonitor({
  jobId,
  compact = false,
}: {
  jobId: string;
  compact?: boolean;
}) {
  const [job, setJob] = useState<AgentJob | null>(null);
  const [logs, setLogs] = useState<AgentJobLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const output = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        agentJob: AgentJob | null;
        agentJobLogs: AgentJobLog[];
      }>(
        `query Job($id: ID!) { agentJob(id: $id) { ${JOB_FIELDS} } agentJobLogs(jobId: $id) { id jobId sequence stream message createdAt } }`,
        { id: jobId },
      );
      setJob(data.agentJob);
      setLogs(data.agentJobLogs);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
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
        query: `subscription JobLog($jobId: ID!) { agentJobLogAdded(jobId: $jobId) { id jobId sequence stream message createdAt } }`,
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
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      unsubscribeJob();
      unsubscribeLogs();
      window.clearInterval(timer);
      window.clearTimeout(initialLoad);
    };
  }, [jobId, load]);

  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [logs]);

  const cancel = async () => {
    const data = await controlPlaneRequest<{ cancelAgentJob: AgentJob }>(
      `mutation Cancel($jobId: ID!) { cancelAgentJob(jobId: $jobId) { ${JOB_FIELDS} } }`,
      { jobId },
    );
    setJob(data.cancelAgentJob);
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!job)
    return <p className="text-sm text-muted-foreground">Loading job…</p>;

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
              <Link href={`/jobs/${job.id}`}>Open job</Link>
            </Button>
          )}
          {(job.status === "QUEUED" || job.status === "RUNNING") && (
            <Button
              onClick={() => void cancel()}
              size="sm"
              variant="destructive"
            >
              <Square />
              Cancel
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
      >
        {logs.length === 0 ? (
          <span className="text-zinc-500">Waiting for output…</span>
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
