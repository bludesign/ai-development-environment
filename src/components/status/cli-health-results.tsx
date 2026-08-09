"use client";

import { Play } from "lucide-react";
import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { AgentCliHealthStatus, CliHealthCheck } from "./types";

function checkVariant(state: CliHealthCheck["state"]) {
  if (state === "HEALTHY") return "secondary" as const;
  if (state === "UNHEALTHY") return "destructive" as const;
  return "outline" as const;
}

function healthyClassName(state: "HEALTHY" | string) {
  return state === "HEALTHY"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
    : undefined;
}

export function overallVariant(status: AgentCliHealthStatus["overall"]) {
  if (status === "HEALTHY") return "secondary" as const;
  if (status === "ISSUES") return "destructive" as const;
  return "outline" as const;
}

export function CliHealthResults({
  status,
  onRun,
  running = false,
}: {
  status: AgentCliHealthStatus;
  onRun?: () => void;
  running?: boolean;
}) {
  const t = useTranslations("systemStatus");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={healthyClassName(status.overall)}
            variant={overallVariant(status.overall)}
          >
            {t(`overall.${status.overall}`)}
          </Badge>
          {status.connectionStatus === "OFFLINE" && status.lastCheckedAt && (
            <Badge variant="outline">{t("cached")}</Badge>
          )}
          {status.lastCheckedAt && (
            <span className="text-xs text-muted-foreground">
              {t("checked")}{" "}
              <DateTime kind="relative" value={status.lastCheckedAt} />
            </span>
          )}
        </div>
        {onRun && (
          <Button
            disabled={
              running ||
              status.connectionStatus === "OFFLINE" ||
              !status.supported
            }
            onClick={onRun}
            size="sm"
            variant="outline"
          >
            {running || status.overall === "RUNNING" ? <Spinner /> : <Play />}
            {t("runAgent")}
          </Button>
        )}
      </div>
      {!status.supported ? (
        <p className="text-sm text-muted-foreground">{t("updateRequired")}</p>
      ) : (
        <Accordion className="rounded-lg border px-3" type="multiple">
          {status.results.map((check) => (
            <AccordionItem key={check.id} value={check.id}>
              <AccordionTrigger>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pr-3">
                  <span>{check.name}</span>
                  <Badge
                    className={healthyClassName(check.state)}
                    variant={checkVariant(check.state)}
                  >
                    {t(`checks.${check.state}`)}
                  </Badge>
                  <code className="min-w-0 truncate text-xs font-normal text-muted-foreground">
                    {check.command}
                  </code>
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {t("exitCode")}: {check.exitCode ?? "—"}
                  </span>
                  {check.durationMs !== null && (
                    <span>
                      {t("duration", { milliseconds: check.durationMs })}
                    </span>
                  )}
                  {check.checkedAt && <DateTime value={check.checkedAt} />}
                  {check.timedOut && <span>{t("timedOut")}</span>}
                  {check.outputTruncated && <span>{t("truncated")}</span>}
                </div>
                {check.stdout && (
                  <Output label={t("stdout")} value={check.stdout} />
                )}
                {check.stderr && (
                  <Output
                    label={t("stderr")}
                    value={check.stderr}
                    destructive={check.state === "UNHEALTHY"}
                  />
                )}
                {!check.stdout && !check.stderr && (
                  <p className="text-xs text-muted-foreground">
                    {t("noOutput")}
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}

function Output({
  label,
  value,
  destructive = false,
}: {
  label: string;
  value: string;
  destructive?: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium">{label}</p>
      <pre
        className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs ${destructive ? "text-destructive" : ""}`}
      >
        {value}
      </pre>
    </div>
  );
}
