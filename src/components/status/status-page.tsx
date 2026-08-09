"use client";

import { Play, RefreshCw, Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { CliHealthResults } from "./cli-health-results";
import { CliHealthSettingsDialog } from "./cli-health-settings-dialog";
import {
  INSTALLATION_STATUS_FIELDS,
  type CustomCliHealthCheck,
  type InstallationStatus,
} from "./types";

export function StatusPage() {
  const t = useTranslations("systemStatus");
  const [status, setStatus] = useState<InstallationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningAgent, setRunningAgent] = useState<string | "all" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        installationStatus: InstallationStatus;
      }>(
        `query InstallationStatus { installationStatus { ${INSTALLATION_STATUS_FIELDS} } }`,
      );
      setStatus(data.installationStatus);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      {
        query:
          "subscription CliHealthStatusChanged { cliHealthStatusChanged { agentId } }",
      },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      unsubscribe();
    };
  }, [load]);
  const run = async (agentId?: string) => {
    setRunningAgent(agentId ?? "all");
    try {
      const data = await controlPlaneRequest<{
        runCliHealthChecks: InstallationStatus;
      }>(
        `mutation RunCliHealthChecks($agentId: ID) { runCliHealthChecks(agentId: $agentId) { ${INSTALLATION_STATUS_FIELDS} } }`,
        { agentId: agentId ?? null },
      );
      setStatus(data.runCliHealthChecks);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setRunningAgent(null);
    }
  };
  const saveSettings = async (checks: CustomCliHealthCheck[]) => {
    const data = await controlPlaneRequest<{
      saveCliHealthSettings: InstallationStatus;
    }>(
      `mutation SaveCliHealthSettings($checks: [CustomCliHealthCheckInput!]!) { saveCliHealthSettings(checks: $checks) { ${INSTALLATION_STATUS_FIELDS} } }`,
      {
        checks: checks.map(({ id, ...check }) => ({
          ...check,
          id: id || null,
        })),
      },
    );
    setStatus(data.saveCliHealthSettings);
  };
  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
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
            aria-label={t("settingsTitle")}
            onClick={() => setSettingsOpen(true)}
            variant="outline"
          >
            <Settings />
            {t("settings")}
          </Button>
          <Button disabled={runningAgent !== null} onClick={() => void run()}>
            <Play />
            {t("runAll")}
          </Button>
          <Button
            aria-label={t("refresh")}
            onClick={() => void load()}
            size="icon"
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && !status ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </p>
      ) : (
        status && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>{t("versions")}</CardTitle>
                <CardDescription>{t("versionsDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Version name={t("serverVersion")} version={status.version} />
                {status.dependencies.map((dependency) => (
                  <Version key={dependency.name} {...dependency} />
                ))}
              </CardContent>
            </Card>
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">{t("agents")}</h2>
              {status.agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noAgents")}</p>
              ) : (
                status.agents.map((agent) => (
                  <Card key={agent.agentId}>
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle>
                            <Link
                              className="hover:underline"
                              href={`/agents/${agent.agentId}`}
                            >
                              {agent.name}
                            </Link>
                          </CardTitle>
                          <CardDescription>
                            {agent.hostname} ·{" "}
                            {t("agentVersion", { version: agent.version })}
                          </CardDescription>
                        </div>
                        <Badge
                          variant={
                            agent.connectionStatus === "ONLINE"
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {t(`connections.${agent.connectionStatus}`)}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <CliHealthResults
                        onRun={() => void run(agent.agentId)}
                        running={runningAgent === agent.agentId}
                        status={agent}
                      />
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </>
        )
      )}
      {status && settingsOpen && (
        <CliHealthSettingsDialog
          checks={status.customChecks}
          onOpenChange={setSettingsOpen}
          onSave={saveSettings}
          open={settingsOpen}
        />
      )}
    </section>
  );
}

function Version({ name, version }: { name: string; version: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{name}</p>
      <p className="mt-1 font-mono text-sm font-medium">{version}</p>
    </div>
  );
}
