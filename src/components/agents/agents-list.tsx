"use client";

import { Copy, Laptop, Plus, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { StatusBadge } from "./status-badge";
import type { Agent } from "./types";

const AGENTS_QUERY = `query Agents { agents {
  id name hostname version osVersion architecture capabilities connectionStatus
  ipAddress lastSeenAt disconnectedAt createdAt
} }`;

export function AgentsList() {
  const t = useTranslations("agents");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{ agents: Agent[] }>(AGENTS_QUERY);
      setAgents(data.agents);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 15_000);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      agentChanged: Agent;
    }>(
      { query: `subscription { agentChanged { id } }` },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(initialLoad);
      unsubscribe();
    };
  }, [load]);

  const createEnrollment = async () => {
    try {
      const data = await controlPlaneRequest<{
        createAgentEnrollmentToken: { token: string; expiresAt: string };
      }>(`mutation { createAgentEnrollmentToken { token expiresAt } }`);
      setEnrollment(data.createAgentEnrollmentToken);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const command = enrollment
    ? `mac-control-agent enroll --server ${typeof window === "undefined" ? "http://127.0.0.1:3090" : window.location.origin} --enrollment-token ${enrollment.token}`
    : "";

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void load()} variant="outline">
            <RefreshCw />
            {t("refresh")}
          </Button>
          <Button onClick={() => void createEnrollment()}>
            <Plus />
            {t("enroll")}
          </Button>
        </div>
      </div>

      {enrollment && (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <h2 className="font-medium">{t("enrollmentTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("enrollmentDescription")}
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted p-3">
            <code className="min-w-0 flex-1 break-all text-xs">{command}</code>
            <Button
              aria-label={t("copy")}
              onClick={() => void navigator.clipboard.writeText(command)}
              size="icon-sm"
              variant="ghost"
            >
              <Copy />
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("expires", {
              date: new Date(enrollment.expiresAt).toLocaleString(),
            })}
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Laptop className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-medium">{t("emptyTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("emptyDescription")}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-muted/50"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">{agent.name}</h2>
                  <p className="truncate text-sm text-muted-foreground">
                    {agent.hostname}
                  </p>
                </div>
                <StatusBadge status={agent.connectionStatus} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <div>
                  <dt>{t("version")}</dt>
                  <dd className="text-foreground">{agent.version}</dd>
                </div>
                <div>
                  <dt>{t("platform")}</dt>
                  <dd className="text-foreground">{agent.architecture}</dd>
                </div>
                <div className="col-span-2">
                  <dt>{t("lastSeen")}</dt>
                  <dd className="text-foreground">
                    {agent.lastSeenAt
                      ? new Date(agent.lastSeenAt).toLocaleString()
                      : t("never")}
                  </dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
