"use client";

import { CODEBASE_BROWSE_JOB_KIND } from "@ai-development-environment/agent-contract/codebases";
import { Copy, FolderCog, Laptop, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { AgentDirectoryBrowser } from "@/components/agents/agent-directory-browser";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { copyText } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { StatusBadge } from "./status-badge";
import { AGENT_FIELDS } from "./graphql-fields";
import type { Agent } from "./types";

const AGENTS_QUERY = `query Agents { agents { ${AGENT_FIELDS} } }`;

export function AgentsList() {
  const t = useTranslations("agents");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [repositoryDirectoriesOpen, setRepositoryDirectoriesOpen] =
    useState(false);

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
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      agentChanged: Agent;
    }>(
      { query: `subscription { agentChanged { ${AGENT_FIELDS} } }` },
      {
        next: (value) => {
          const changed = value.data?.agentChanged;
          if (!changed) return;
          setAgents((current) => {
            const existing = current.findIndex(
              (agent) => agent.id === changed.id,
            );
            if (existing === -1) return [changed, ...current];
            return current.map((agent, index) =>
              index === existing ? changed : agent,
            );
          });
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
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

  const copyEnrollmentCommand = async () => {
    try {
      await copyText(command);
    } catch {
      setError(t("copyFailed"));
    }
  };

  const command = enrollment
    ? `control-agent enroll --server ${typeof window === "undefined" ? "http://127.0.0.1:3090" : window.location.origin} --enrollment-token ${enrollment.token}`
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
          <Button
            onClick={() => setRepositoryDirectoriesOpen(true)}
            variant="outline"
          >
            <FolderCog />
            {t("repositoryDirectories")}
          </Button>
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
        <Card>
          <CardContent>
            <h2 className="font-medium">{t("enrollmentTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("enrollmentDescription")}
            </p>
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted p-3">
              <code className="min-w-0 flex-1 break-all text-xs">
                {command}
              </code>
              <Button
                aria-label={t("copy")}
                onClick={() => void copyEnrollmentCommand()}
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
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </p>
      ) : agents.length === 0 ? (
        <Empty className="border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Laptop />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardContent>
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
                    <div className="col-span-2 min-w-0">
                      <dt>{t("baseRepoDirectory")}</dt>
                      <dd
                        className="truncate font-mono text-foreground"
                        title={agent.baseRepoDirectory ?? t("notConfigured")}
                      >
                        {agent.baseRepoDirectory ?? t("notConfigured")}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <BaseRepoDirectoryDialog
        agents={agents}
        onOpenChange={setRepositoryDirectoriesOpen}
        onSaved={(updated) =>
          setAgents((current) =>
            current.map((agent) => (agent.id === updated.id ? updated : agent)),
          )
        }
        open={repositoryDirectoriesOpen}
      />
    </section>
  );
}

function BaseRepoDirectoryDialog({
  agents,
  onOpenChange,
  onSaved,
  open,
}: {
  agents: Agent[];
  onOpenChange: (open: boolean) => void;
  onSaved: (agent: Agent) => void;
  open: boolean;
}) {
  const t = useTranslations("agents");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compatible = agents.filter(
    (agent) =>
      agent.connectionStatus === "ONLINE" &&
      agent.capabilities.includes(CODEBASE_BROWSE_JOB_KIND),
  );
  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setAgentId("");
      setBusy(false);
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const save = async (baseRepoDirectory: string | null) => {
    if (!agentId) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        updateAgentBaseRepoDirectory: Agent;
      }>(
        `mutation UpdateAgentBaseRepoDirectory($agentId: ID!, $baseRepoDirectory: String) {
          updateAgentBaseRepoDirectory(agentId: $agentId, baseRepoDirectory: $baseRepoDirectory) {
            ${AGENT_FIELDS}
          }
        }`,
        { agentId, baseRepoDirectory },
      );
      onSaved(data.updateAgentBaseRepoDirectory);
      handleOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("baseRepoDirectory")}</DialogTitle>
          <DialogDescription>
            {t("baseRepoDirectoryDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {compatible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noDirectoryAgents")}
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="base-directory-agent">{t("agent")}</Label>
              <Select
                onValueChange={(value) => {
                  setAgentId(value);
                  setError(null);
                }}
                value={agentId}
              >
                <SelectTrigger className="w-full" id="base-directory-agent">
                  <SelectValue placeholder={t("selectAgent")} />
                </SelectTrigger>
                <SelectContent>
                  {compatible.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} · {agent.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {selectedAgent && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted p-3">
                <p className="text-xs text-muted-foreground">
                  {t("currentDirectory")}
                </p>
                <p className="mt-1 break-all font-mono text-xs">
                  {selectedAgent.baseRepoDirectory ?? t("notConfigured")}
                </p>
              </div>
              <AgentDirectoryBrowser
                agentId={selectedAgent.id}
                disabled={busy}
                key={selectedAgent.id}
                onSelect={(path) => save(path)}
                selectLabel={t("useDirectory")}
              />
              {selectedAgent.baseRepoDirectory && (
                <Button
                  disabled={busy}
                  onClick={() => void save(null)}
                  type="button"
                  variant="outline"
                >
                  <Trash2 /> {t("clearDirectory")}
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
