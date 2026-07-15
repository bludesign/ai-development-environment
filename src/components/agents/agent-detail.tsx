"use client";

import { ArrowLeft, Play } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { JobMonitor } from "@/components/agents/job-monitor";
import { StatusBadge } from "@/components/agents/status-badge";
import type { Agent, AgentJob } from "@/components/agents/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

const AGENT_FIELDS = `id name hostname version osVersion architecture capabilities connectionStatus ipAddress lastSeenAt disconnectedAt createdAt`;
const JOB_FIELDS = `id agentId kind payload status error result timeoutSeconds createdAt startedAt finishedAt updatedAt`;

export function AgentDetail({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [tunnelName, setTunnelName] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setSelectedJobId((current) => current ?? data.agentJobs[0]?.id ?? null);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [agentId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 10_000);
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
      window.clearInterval(timer);
      window.clearTimeout(initialLoad);
      unsubscribe();
    };
  }, [agentId, load]);

  const startTunnel = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    try {
      const data = await controlPlaneRequest<{ createAgentJob: AgentJob }>(
        `mutation RunTunnel($input: CreateAgentJobInput!) { createAgentJob(input: $input) { ${JOB_FIELDS} } }`,
        {
          input: {
            agentId,
            kind: "cloudflared.runTunnel",
            payload: { tunnelName },
            idempotencyKey: `cloudflared:${tunnelName}:${crypto.randomUUID()}`,
            timeoutSeconds: 86400,
          },
        },
      );
      setJobs((current) => [data.createAgentJob, ...current]);
      setSelectedJobId(data.createAgentJob.id);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setCreating(false);
    }
  };

  if (error && !agent)
    return (
      <p className="mx-auto max-w-6xl text-sm text-destructive">{error}</p>
    );
  if (!agent)
    return (
      <p className="mx-auto max-w-6xl text-sm text-muted-foreground">
        Loading agent…
      </p>
    );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/agents">
            <ArrowLeft />
            Agents
          </Link>
        </Button>
      </div>
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
            <dt className="text-muted-foreground">Version</dt>
            <dd>{agent.version}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last seen</dt>
            <dd>
              {agent.lastSeenAt
                ? new Date(agent.lastSeenAt).toLocaleString()
                : "Never"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Capabilities</dt>
            <dd>{agent.capabilities.join(", ")}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="font-medium">Run Cloudflared Tunnel</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Starts the allow-listed cloudflared handler on this Mac. It keeps
          running in the agent service when you leave this page.
        </p>
        <form
          className="mt-4 flex max-w-xl gap-2"
          onSubmit={(event) => void startTunnel(event)}
        >
          <Input
            aria-label="Tunnel name"
            onChange={(event) => setTunnelName(event.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}"
            placeholder="example-tunnel"
            required
            value={tunnelName}
          />
          <Button disabled={creating} type="submit">
            <Play />
            {creating ? "Queuing…" : "Run"}
          </Button>
        </form>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </section>

      {selectedJobId && <JobMonitor compact jobId={selectedJobId} />}

      <section>
        <h2 className="mb-3 font-medium">Job history</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No jobs have run on this agent.
          </p>
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
                    {new Date(job.createdAt).toLocaleString()}
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
