"use client";

import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { DISK_SPACE_FIELDS, type DiskSpaceOverview } from "./types";
import { VolumeBar } from "./volume-bar";

const ACTIVE_CONTROL_CLASS =
  "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-300";
const ACTIVE_PRESSURE_CLASS =
  "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20 dark:hover:text-amber-300";

export function DiskSpaceMonitor() {
  const t = useTranslations("diskSpace");
  const [overview, setOverview] = useState<DiskSpaceOverview | null>(null);
  const [normal, setNormal] = useState("40");
  const [pressure, setPressure] = useState("10");
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  ): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      await controlPlaneRequest(query, variables);
      await load();
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
        <Dialog
          onOpenChange={(open) => {
            if (open && overview) {
              setNormal(String(overview.settings.normalThresholdGiB));
              setPressure(String(overview.settings.pressureThresholdGiB));
            }
            setSettingsOpen(open);
          }}
          open={settingsOpen}
        >
          <CardAction>
            <DialogTrigger asChild>
              <Button disabled={!overview} size="sm" variant="outline">
                {t("settings")}
              </Button>
            </DialogTrigger>
          </CardAction>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("settings")}</DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={async (event) => {
                event.preventDefault();
                const saved = await mutate(
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
                );
                if (saved) setSettingsOpen(false);
              }}
            >
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
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
              <DialogFooter>
                <Button disabled={busy !== null} type="submit">
                  {busy === "settings" ? <Spinner /> : <Save />}{" "}
                  {t("saveThresholds")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-5">
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
                        <Badge
                          className={
                            agent.status === "PRESSURE"
                              ? ACTIVE_PRESSURE_CLASS
                              : undefined
                          }
                          variant={
                            agent.status === "PRESSURE"
                              ? "outline"
                              : "secondary"
                          }
                        >
                          {t(`status.${agent.status}`)}
                        </Badge>
                        {agent.pressureMode !== "NORMAL" && (
                          <Badge
                            className={ACTIVE_PRESSURE_CLASS}
                            variant="outline"
                          >
                            {t(`pressureMode.${agent.pressureMode}`)}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        aria-pressed={agent.enabled}
                        className={
                          agent.enabled ? ACTIVE_CONTROL_CLASS : undefined
                        }
                        disabled={busy !== null}
                        onClick={() =>
                          void mutate(
                            `monitor:${agent.agent.id}`,
                            `mutation SetAgentDiskSpaceMonitoring($agentId: ID!, $enabled: Boolean!) {
                              setAgentDiskSpaceMonitoring(agentId: $agentId, enabled: $enabled) { enabled }
                            }`,
                            {
                              agentId: agent.agent.id,
                              enabled: !agent.enabled,
                            },
                          )
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("monitorAgent")}
                      </Button>
                      <Button
                        aria-pressed={agent.manualPressureMode}
                        className={
                          agent.manualPressureMode
                            ? ACTIVE_PRESSURE_CLASS
                            : undefined
                        }
                        disabled={!agent.enabled || busy !== null}
                        onClick={() =>
                          void mutate(
                            `pressure:${agent.agent.id}`,
                            `mutation SetAgentDiskSpacePressureMode($agentId: ID!, $enabled: Boolean!) {
                              setAgentDiskSpacePressureMode(agentId: $agentId, enabled: $enabled) { manualPressureMode }
                            }`,
                            {
                              agentId: agent.agent.id,
                              enabled: !agent.manualPressureMode,
                            },
                          )
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("pressureModeControl")}
                      </Button>
                    </div>
                  </div>
                  {agent.volumes.length ? (
                    <div className="space-y-3">
                      {agent.volumes.map((volume) => (
                        <Tooltip key={volume.id}>
                          <TooltipTrigger asChild>
                            <div
                              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              tabIndex={0}
                            >
                              <VolumeBar hideStatus volume={volume} />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            {volume.monitored
                              ? t(`status.${volume.status}`)
                              : t("notMonitored")}
                          </TooltipContent>
                        </Tooltip>
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
                        value: "",
                      })}
                      <DateTime value={agent.lastReportedAt} />
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
