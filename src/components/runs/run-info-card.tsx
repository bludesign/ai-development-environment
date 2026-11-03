"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatProviderLabel } from "@/lib/enum-label";

import type { AgentRunView } from "./types";

type RunInfo = Pick<
  AgentRunView,
  | "kind"
  | "provider"
  | "providerVersion"
  | "origin"
  | "attempts"
  | "agentId"
  | "repositoryName"
  | "branch"
  | "model"
  | "effort"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "updatedAt"
>;

function InfoRow({
  label,
  value,
  copy = false,
  children,
}: {
  label: string;
  value?: string | null;
  copy?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("runs.info");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const copied = Boolean(value && copiedValue === value);
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-start gap-2 text-sm">
        <span
          className={
            copy && value
              ? "min-w-0 font-mono text-xs wrap-anywhere"
              : "min-w-0 wrap-anywhere"
          }
        >
          {children ?? value ?? t("unavailable")}
        </span>
        {copy && value && (
          <Button
            aria-label={t("copyValue", { label })}
            className="size-6 shrink-0"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopiedValue(value);
                setCopyFailed(false);
              } catch {
                setCopiedValue(null);
                setCopyFailed(true);
              }
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            {copied ? (
              <Check className="size-3" />
            ) : (
              <Copy className="size-3" />
            )}
          </Button>
        )}
      </dd>
      <div aria-live="polite" className="text-xs text-muted-foreground">
        {copyFailed ? t("copyFailed") : copied ? t("copied") : null}
      </div>
    </div>
  );
}

export function RunInfoCard({ run }: { run: RunInfo }) {
  const t = useTranslations("runs");
  const info = useTranslations("runs.info");
  const attempt = run.attempts
    .filter(({ supersededAt }) => !supersededAt)
    .reduce<RunInfo["attempts"][number] | null>(
      (latest, candidate) =>
        !latest || candidate.generation > latest.generation
          ? candidate
          : latest,
      null,
    );
  const sessionInfo = attempt?.sessionInfo;
  const dates = [
    ["createdAt", run.createdAt],
    ["startedAt", run.startedAt],
    ["finishedAt", run.finishedAt],
    ["updatedAt", run.updatedAt],
  ] as const;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          {info(run.kind === "PLAN" ? "planTitle" : "sessionTitle")}
        </CardTitle>
        <CardDescription>{info("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid min-w-0 gap-x-6 gap-y-4 sm:grid-cols-2">
          <InfoRow
            label={t("provider")}
            value={formatProviderLabel(run.provider)}
          />
          <InfoRow
            label={info("providerVersion")}
            value={run.providerVersion}
          />
          <InfoRow
            label={t("origin")}
            value={t(run.origin === "IMPORTED" ? "imported" : "managed")}
          />
          <InfoRow
            label={info("nativeSessionId")}
            value={attempt?.nativeId}
            copy
          />
          <InfoRow
            label={info("nativeTranscriptPath")}
            value={
              run.provider === "OPENCODE"
                ? null
                : sessionInfo?.nativeTranscriptPath
            }
            copy
          >
            {run.provider === "OPENCODE" ? info("noStandaloneFile") : undefined}
          </InfoRow>
          <InfoRow
            label={info("activityLogPath")}
            value={
              run.origin === "IMPORTED" ? null : sessionInfo?.activityLogPath
            }
            copy
          >
            {run.origin === "IMPORTED"
              ? info("noImportedActivityLog")
              : undefined}
          </InfoRow>
          <InfoRow
            label={info("workingDirectory")}
            value={sessionInfo?.workingDirectory}
            copy
          />
          <InfoRow label={info("agentId")} value={run.agentId} copy />
          <InfoRow label={info("repository")} value={run.repositoryName} />
          <InfoRow label={info("branch")} value={run.branch} />
          <InfoRow label={t("model")} value={run.model} />
          <InfoRow label={t("effort")} value={run.effort} />
          {dates.map(([key, value]) => (
            <InfoRow key={key} label={info(key)}>
              <DateTime value={value} fallback={info("unavailable")} />
            </InfoRow>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
