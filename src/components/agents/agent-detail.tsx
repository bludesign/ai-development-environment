"use client";

import { TUNNEL_NAME_PATTERN } from "@ai-development-environment/agent-contract";
import { ArrowLeft, Play } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { JobMonitor } from "@/components/agents/job-monitor";
import { StatusBadge } from "@/components/agents/status-badge";
import type { Agent, AgentJob } from "@/components/agents/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { AGENT_FIELDS, JOB_FIELDS } from "./graphql-fields";

export function AgentDetail({ agentId }: { agentId: string }) {
  const t = useTranslations("agentDetail");
  const locale = useLocale();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [tunnelName, setTunnelName] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        agent: Agent | null;
        agentJobs: AgentJob[];
      }>(
        `query AgentDetail($id: ID!) { agent(id: $id) { ${AGENT_FIELDS} } agentJobs(agentId: $id) { ${JOB_FIELDS} } }`,
        { id: agentId },
      );
      setAgent(data.agent);
      setJobs(data.agentJobs);
      setSelectedJobId((current) =>
        current && data.agentJobs.some((job) => job.id === current)
          ? current
          : (data.agentJobs[0]?.id ?? null),
      );
      setLoadError(null);
    } catch (value) {
      setLoadError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      agentChanged: Agent;
    }>(
      {
        query: `subscription AgentChanged($agentId: ID!) { agentChanged(agentId: $agentId) { ${AGENT_FIELDS} } }`,
        variables: { agentId },
      },
      {
        next: (value) =>
          value.data?.agentChanged && setAgent(value.data.agentChanged),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initialLoad);
      unsubscribe();
    };
  }, [agentId, load]);

  const activeJobIds = useMemo(
    () =>
      jobs
        .filter((job) => job.status === "QUEUED" || job.status === "RUNNING")
        .map((job) => job.id),
    [jobs],
  );

  useEffect(() => {
    const client = controlPlaneSubscriptions();
    const unsubscribers = activeJobIds.map((jobId) =>
      client.subscribe<{ agentJobChanged: AgentJob }>(
        {
          query: `subscription JobChanged($jobId: ID!) { agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} } }`,
          variables: { jobId },
        },
        {
          next: (value) => {
            const changed = value.data?.agentJobChanged;
            if (!changed) return;
            setJobs((current) =>
              current.map((job) => (job.id === changed.id ? changed : job)),
            );
          },
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [activeJobIds]);

  const startTunnel = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setSubmitError(null);
    try {
      const data = await controlPlaneRequest<{ createAgentJob: AgentJob }>(
        `mutation RunTunnel($input: CreateAgentJobInput!) { createAgentJob(input: $input) { ${JOB_FIELDS} } }`,
        {
          input: {
            agentId,
            kind: "cloudflared.runTunnel",
            payload: { tunnelName },
            idempotencyKey: `cloudflared:${tunnelName}:${createClientId()}`,
            timeoutSeconds: 86400,
          },
        },
      );
      setJobs((current) => [
        data.createAgentJob,
        ...current.filter((job) => job.id !== data.createAgentJob.id),
      ]);
      setSelectedJobId(data.createAgentJob.id);
    } catch (value) {
      setSubmitError(value instanceof Error ? value.message : String(value));
    } finally {
      setCreating(false);
    }
  };

  if (loading)
    return (
      <p className="mx-auto max-w-6xl text-sm text-muted-foreground">
        {t("loading")}
      </p>
    );
  if (loadError && !agent)
    return (
      <p className="mx-auto max-w-6xl text-sm text-destructive">{loadError}</p>
    );
  if (!agent)
    return (
      <p className="mx-auto max-w-6xl text-sm text-muted-foreground">
        {t("notFound")}
      </p>
    );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/agents">
            <ArrowLeft />
            {t("back")}
          </Link>
        </Button>
      </div>
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                {agent.name}
              </h1>
              <StatusBadge status={agent.connectionStatus} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {agent.hostname} · {agent.osVersion} · {agent.architecture}
            </p>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{agent.id}</p>
        </div>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t("version")}</dt>
            <dd>{agent.version}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("lastSeen")}</dt>
            <dd>
              {agent.lastSeenAt
                ? new Date(agent.lastSeenAt).toLocaleString(locale)
                : t("never")}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("capabilities")}</dt>
            <dd>{agent.capabilities.join(", ")}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="font-medium">{t("runTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("runDescription")}
        </p>
        <form
          className="mt-4 flex max-w-xl gap-2"
          onSubmit={(event) => void startTunnel(event)}
        >
          <Input
            aria-label={t("tunnelName")}
            onChange={(event) => setTunnelName(event.target.value)}
            pattern={TUNNEL_NAME_PATTERN}
            placeholder={t("tunnelPlaceholder")}
            required
            value={tunnelName}
          />
          <Button disabled={creating} type="submit">
            <Play />
            {creating ? t("queuing") : t("run")}
          </Button>
        </form>
        {submitError && (
          <p className="mt-3 text-sm text-destructive">{submitError}</p>
        )}
      </section>

      {selectedJobId && (
        <JobMonitor key={selectedJobId} compact jobId={selectedJobId} />
      )}

      <section>
        <h2 className="mb-3 font-medium">{t("history")}</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noJobs")}</p>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            {jobs.map((job) => (
              <button
                key={job.id}
                className="flex w-full items-center justify-between gap-4 border-b p-3 text-left last:border-b-0 hover:bg-muted/50"
                onClick={() => setSelectedJobId(job.id)}
                type="button"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{job.kind}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(job.createdAt).toLocaleString(locale)}
                  </p>
                </div>
                <StatusBadge status={job.status} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
