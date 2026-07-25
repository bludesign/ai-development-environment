"use client";

import { HardDrive, Save } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { DISK_SPACE_FIELDS, type DiskSpaceOverview } from "./types";
import { VolumeBar } from "./volume-bar";

export function DiskSpaceMonitor() {
  const t = useTranslations("diskSpace");
  const [overview, setOverview] = useState<DiskSpaceOverview | null>(null);
  const [normal, setNormal] = useState("40");
  const [pressure, setPressure] = useState("10");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        diskSpaceOverview: DiskSpaceOverview;
      }>(
        `query DiskSpaceOverview { diskSpaceOverview { ${DISK_SPACE_FIELDS} } }`,
      );
      setOverview(data.diskSpaceOverview);
      setNormal(String(data.diskSpaceOverview.settings.normalThresholdGiB));
      setPressure(String(data.diskSpaceOverview.settings.pressureThresholdGiB));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      diskSpaceChanged: string;
    }>(
      { query: "subscription DiskSpaceChanged { diskSpaceChanged }" },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initialLoad);
      unsubscribe();
    };
  }, [load]);

  const mutate = async (
    key: string,
    query: string,
    variables: Record<string, unknown>,
  ) => {
    setBusy(key);
    setError(null);
    try {
      await controlPlaneRequest(query, variables);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <CardHeader>
        <div className="flex items-center gap-2">
          <HardDrive className="size-5" />
          <CardTitle>{t("title")}</CardTitle>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pb-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!overview ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("loading")}
          </p>
        ) : (
          <>
            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="disk-normal-threshold">
                  {t("normalThreshold")}
                </Label>
                <Input
                  id="disk-normal-threshold"
                  min="0.1"
                  onChange={(event) => setNormal(event.target.value)}
                  step="0.1"
                  type="number"
                  value={normal}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="disk-pressure-threshold">
                  {t("pressureThreshold")}
                </Label>
                <Input
                  id="disk-pressure-threshold"
                  min="0.1"
                  onChange={(event) => setPressure(event.target.value)}
                  step="0.1"
                  type="number"
                  value={pressure}
                />
              </div>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void mutate(
                    "settings",
                    `mutation UpdateDiskSpaceSettings($input: UpdateDiskSpaceSettingsInput!) {
                      updateDiskSpaceSettings(input: $input) { normalThresholdGiB }
                    }`,
                    {
                      input: {
                        normalThresholdGiB: Number(normal),
                        pressureThresholdGiB: Number(pressure),
                      },
                    },
                  )
                }
              >
                {busy === "settings" ? <Spinner /> : <Save />}{" "}
                {t("saveThresholds")}
              </Button>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              {overview.agents.map((agent) => (
                <div
                  className="space-y-4 rounded-lg border p-4"
                  key={agent.agent.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Link
                        className="font-medium hover:underline"
                        href={`/agents/${agent.agent.id}`}
                      >
                        {agent.agent.name}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Badge variant="secondary">
                          {t(`status.${agent.status}`)}
                        </Badge>
                        {agent.pressureMode !== "NORMAL" && (
                          <Badge variant="outline">
                            {t(`pressureMode.${agent.pressureMode}`)}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2 text-sm">
                      <Label className="flex items-center gap-2">
                        <Checkbox
                          checked={agent.enabled}
                          disabled={busy !== null}
                          onCheckedChange={(checked) =>
                            void mutate(
                              `monitor:${agent.agent.id}`,
                              `mutation SetAgentDiskSpaceMonitoring($agentId: ID!, $enabled: Boolean!) {
                                setAgentDiskSpaceMonitoring(agentId: $agentId, enabled: $enabled) { enabled }
                              }`,
                              {
                                agentId: agent.agent.id,
                                enabled: checked === true,
                              },
                            )
                          }
                        />
                        {t("monitorAgent")}
                      </Label>
                      <Label className="flex items-center gap-2">
                        <Checkbox
                          checked={agent.manualPressureMode}
                          disabled={!agent.enabled || busy !== null}
                          onCheckedChange={(checked) =>
                            void mutate(
                              `pressure:${agent.agent.id}`,
                              `mutation SetAgentDiskSpacePressureMode($agentId: ID!, $enabled: Boolean!) {
                                setAgentDiskSpacePressureMode(agentId: $agentId, enabled: $enabled) { manualPressureMode }
                              }`,
                              {
                                agentId: agent.agent.id,
                                enabled: checked === true,
                              },
                            )
                          }
                        />
                        {t("pressureModeControl")}
                      </Label>
                    </div>
                  </div>
                  {agent.volumes.length ? (
                    <div className="space-y-3">
                      {agent.volumes.map((volume) => (
                        <VolumeBar key={volume.id} volume={volume} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("noReport")}
                    </p>
                  )}
                  {agent.lastReportedAt && (
                    <p className="text-xs text-muted-foreground">
                      {t("observedAt", {
                        value: new Date(agent.lastReportedAt).toLocaleString(),
                      })}
                    </p>
                  )}
                  {(agent.lastError || agent.warnings.length > 0) && (
                    <Alert
                      variant={agent.lastError ? "destructive" : "default"}
                    >
                      <AlertDescription>
                        {[agent.lastError, ...agent.warnings]
                          .filter(Boolean)
                          .join(" · ")}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
