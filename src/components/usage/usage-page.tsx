"use client";

import { CCUSAGE_REPORT_JOB_KIND } from "@ai-development-environment/agent-contract";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useState } from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import type { Agent } from "@/components/agents/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";

import type { AggregatedUsage, UsageMetrics } from "./aggregate-usage";
import { UsageCostChart } from "./usage-cost-chart";

const RECONCILE_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set<CollectionStatus>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

type CollectionStatus =
  | "QUEUING"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "OFFLINE"
  | "UNSUPPORTED"
  | "INVALID";

type AgentCollection = {
  agent: Agent;
  status: CollectionStatus;
  jobId: string | null;
  error: string | null;
};

type UsageRange = "ALL" | "LAST_7_DAYS" | "LAST_30_DAYS";

type CcusageCollection = {
  id: string;
  status: "COLLECTING" | "COMPLETED";
  createdAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  progress: {
    eligibleCount: number;
    finishedCount: number;
    successfulCount: number;
    agents: AgentCollection[];
  };
  aggregate: AggregatedUsage;
  allAggregate: { days: Array<{ period: string }> };
};

const METRICS_FIELDS = `inputTokens outputTokens cacheCreationTokens cacheReadTokens totalTokens totalCost`;
const COLLECTION_FIELDS = `
  id status createdAt deadlineAt finishedAt
  progress {
    eligibleCount finishedCount successfulCount
    agents { agent { ${AGENT_FIELDS} } status jobId error }
  }
  aggregate(range: $range) {
    totals { ${METRICS_FIELDS} }
    days {
      period sources ${METRICS_FIELDS}
      models {
        modelName unattributed ${METRICS_FIELDS}
        agents { agentId agentName hostname sources ${METRICS_FIELDS} }
      }
    }
  }
  allAggregate: aggregate(range: ALL) { days { period } }
`;

function terminal(status: CollectionStatus): boolean {
  return status === "INVALID" || TERMINAL_STATUSES.has(status);
}

export function UsagePage() {
  const t = useTranslations("usage");
  const locale = useLocale();
  const [requestId, setRequestId] = useState(createClientId);
  const [collection, setCollection] = useState<CcusageCollection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [range, setRange] = useState<UsageRange>("ALL");

  useEffect(() => {
    let disposed = false;
    let completed = false;
    let reconcileTimer: number | undefined;
    const applyCollection = (next: CcusageCollection) => {
      if (disposed) return;
      setCollection(next);
      setLoading(false);
      setLoadError(null);
      if (next.status === "COMPLETED") {
        completed = true;
        if (reconcileTimer !== undefined) {
          window.clearInterval(reconcileTimer);
          reconcileTimer = undefined;
        }
      }
    };
    const reconcile = async () => {
      try {
        const data = await controlPlaneRequest<{
          ccusageCollection: CcusageCollection | null;
        }>(
          `query CcusageCollection($id: ID!, $range: CcusageRange!) {
            ccusageCollection(id: $id) { ${COLLECTION_FIELDS} }
          }`,
          { id: requestId, range },
        );
        if (data.ccusageCollection) applyCollection(data.ccusageCollection);
      } catch {
        // The blocking mutation, subscription, or next pass can still deliver it.
      }
    };
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      ccusageCollectionChanged: CcusageCollection;
    }>(
      {
        query: `subscription CcusageCollectionChanged($id: ID!, $range: CcusageRange!) {
          ccusageCollectionChanged(id: $id) { ${COLLECTION_FIELDS} }
        }`,
        variables: { id: requestId, range },
      },
      {
        next: (value) => {
          if (value.data?.ccusageCollectionChanged) {
            applyCollection(value.data.ccusageCollectionChanged);
          }
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    void reconcile();
    if (!completed) {
      reconcileTimer = window.setInterval(
        () => void reconcile(),
        RECONCILE_INTERVAL_MS,
      );
    }
    return () => {
      disposed = true;
      unsubscribe();
      if (reconcileTimer !== undefined) window.clearInterval(reconcileTimer);
    };
  }, [range, requestId]);

  useEffect(() => {
    let disposed = false;
    void controlPlaneRequest<{ collectCcusage: { id: string } }>(
      `mutation CollectCcusage($requestId: ID!) {
        collectCcusage(requestId: $requestId) { id }
      }`,
      { requestId },
    ).catch((error) => {
      if (disposed) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [requestId]);

  const records = collection?.progress.agents ?? [];
  const usage = collection?.aggregate;
  const collecting = collection?.status === "COLLECTING";
  const successful = records.filter((record) => record.status === "SUCCEEDED");
  const eligible = records.filter(
    (record) => record.status !== "OFFLINE" && record.status !== "UNSUPPORTED",
  );
  const offline = records.filter((record) => record.status === "OFFLINE");
  const unsupported = records.filter(
    (record) => record.status === "UNSUPPORTED",
  );
  const failures = records.filter(
    (record) => terminal(record.status) && record.status !== "SUCCEEDED",
  );

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
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            onValueChange={(value) => setRange(value as UsageRange)}
            value={range}
          >
            <TabsList aria-label={t("rangeLabel")}>
              {(
                [
                  ["ALL", t("allData")],
                  ["LAST_7_DAYS", t("last7Days")],
                  ["LAST_30_DAYS", t("last30Days")],
                ] as const
              ).map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            disabled={loading || collecting}
            onClick={() => {
              setCollection(null);
              setLoading(true);
              setLoadError(null);
              setRequestId(createClientId());
            }}
            variant="outline"
          >
            <RefreshCw className={collecting ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {(collecting || records.length > 0) && (
        <CollectionStatusPanel
          collecting={collecting}
          eligibleCount={collection?.progress.eligibleCount ?? eligible.length}
          failures={failures}
          offline={offline}
          successfulCount={
            collection?.progress.successfulCount ?? successful.length
          }
          unsupported={unsupported}
        />
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </p>
      ) : records.length === 0 && !loadError ? (
        <UsageEmpty
          title={t("noAgents")}
          description={t("noAgentsDescription")}
        />
      ) : eligible.length === 0 ? (
        <UsageEmpty
          title={
            records.some((record) =>
              record.agent.capabilities.includes(CCUSAGE_REPORT_JOB_KIND),
            )
              ? t("noOnline")
              : t("noCompatible")
          }
          description={
            records.some((record) =>
              record.agent.capabilities.includes(CCUSAGE_REPORT_JOB_KIND),
            )
              ? t("noOnlineDescription")
              : t("noCompatibleDescription")
          }
        />
      ) : successful.length === 0 && !collecting ? (
        <UsageEmpty
          title={t("collectionFailed")}
          description={t("collectionFailedDescription")}
        />
      ) : successful.length > 0 &&
        collection?.allAggregate.days.length === 0 ? (
        <UsageEmpty
          title={t("zeroUsage")}
          description={t("zeroUsageDescription")}
        />
      ) : successful.length > 0 && usage && usage.days.length === 0 ? (
        <UsageEmpty
          title={t("noUsageInRange")}
          description={t("noUsageInRangeDescription")}
        />
      ) : successful.length > 0 && usage ? (
        <>
          <UsageCostChart days={usage.days} />
          <SummaryTiles metrics={usage.totals} />
          <UsageTable days={usage.days} locale={locale} totals={usage.totals} />
        </>
      ) : null}
    </section>
  );
}

function CollectionStatusPanel({
  collecting,
  eligibleCount,
  failures,
  offline,
  successfulCount,
  unsupported,
}: {
  collecting: boolean;
  eligibleCount: number;
  failures: AgentCollection[];
  offline: AgentCollection[];
  successfulCount: number;
  unsupported: AgentCollection[];
}) {
  const t = useTranslations("usage");
  const names = (items: AgentCollection[]) =>
    items.map((item) => item.agent.name).join(", ");
  return (
    <Alert
      variant={
        failures.length > 0 && successfulCount === 0 ? "destructive" : "default"
      }
    >
      <AlertDescription className="space-y-1">
        <p className="flex items-center gap-2 font-medium">
          {collecting && <Spinner />}
          {t("progress", { complete: successfulCount, total: eligibleCount })}
        </p>
        {offline.length > 0 && (
          <p>{t("offlineAgents", { agents: names(offline) })}</p>
        )}
        {unsupported.length > 0 && (
          <p>{t("unsupportedAgents", { agents: names(unsupported) })}</p>
        )}
        {failures.length > 0 && (
          <p>
            {t("failedAgents", {
              agents: failures
                .map(
                  (item) =>
                    `${item.agent.name}${item.error ? ` (${item.error})` : ""}`,
                )
                .join(", "),
            })}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function SummaryTiles({ metrics }: { metrics: UsageMetrics }) {
  const t = useTranslations("usage");
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const currency = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const tiles = [
    [t("totalCost"), currency.format(metrics.totalCost)],
    [t("totalTokens"), number.format(metrics.totalTokens)],
    [t("inputTokens"), number.format(metrics.inputTokens)],
    [t("outputTokens"), number.format(metrics.outputTokens)],
    [t("cacheCreationTokens"), number.format(metrics.cacheCreationTokens)],
    [t("cacheReadTokens"), number.format(metrics.cacheReadTokens)],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {tiles.map(([label, value]) => (
        <Card key={label}>
          <CardContent>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UsageTable({
  days,
  locale,
  totals,
}: {
  days: AggregatedUsage["days"];
  locale: string;
  totals: UsageMetrics;
}) {
  const t = useTranslations("usage");
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const formatDay = (value: string) =>
    formatDateValue(value, "short", { locale, utc: true, showTime: false });
  const toggle = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
  ) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card className="gap-0 py-0">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("usage")}</TableHead>
            <TableHead className="text-right">{t("input")}</TableHead>
            <TableHead className="text-right">{t("output")}</TableHead>
            <TableHead className="text-right">{t("cacheCreation")}</TableHead>
            <TableHead className="text-right">{t("cacheRead")}</TableHead>
            <TableHead className="text-right">{t("total")}</TableHead>
            <TableHead className="text-right">{t("cost")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map((day) => {
            const dayExpanded = expandedDays.has(day.period);
            return (
              <Fragment key={day.period}>
                <TableRow
                  className="cursor-pointer bg-muted/20 font-medium"
                  onClick={() => toggle(setExpandedDays, day.period)}
                >
                  <TableCell>
                    <button
                      aria-expanded={dayExpanded}
                      aria-label={t(dayExpanded ? "hideModels" : "showModels", {
                        date: day.period,
                      })}
                      className="flex items-center gap-2 text-left"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(setExpandedDays, day.period);
                      }}
                      type="button"
                    >
                      {dayExpanded ? <ChevronDown /> : <ChevronRight />}
                      <span>
                        {formatDay(`${day.period}T00:00:00Z`)}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {t("modelCount", { count: day.models.length })}
                        </span>
                      </span>
                    </button>
                  </TableCell>
                  <MetricCells metrics={day} />
                </TableRow>
                {dayExpanded &&
                  day.models.map((model) => {
                    const modelLabel = model.unattributed
                      ? t("unattributedTokens")
                      : model.modelName;
                    const modelKey = `${day.period}:${model.unattributed ? "unattributed" : model.modelName}`;
                    const modelExpanded = expandedModels.has(modelKey);
                    return (
                      <Fragment key={modelKey}>
                        <TableRow
                          className="cursor-pointer bg-muted/10"
                          onClick={() => toggle(setExpandedModels, modelKey)}
                        >
                          <TableCell>
                            <button
                              aria-expanded={modelExpanded}
                              aria-label={t(
                                modelExpanded ? "hideAgents" : "showAgents",
                                { model: modelLabel },
                              )}
                              className="flex items-center gap-2 pl-6 text-left"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggle(setExpandedModels, modelKey);
                              }}
                              type="button"
                            >
                              {modelExpanded ? (
                                <ChevronDown />
                              ) : (
                                <ChevronRight />
                              )}
                              <span>
                                {modelLabel}
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {t("agentCount", {
                                    count: model.agents.length,
                                  })}
                                </span>
                              </span>
                            </button>
                          </TableCell>
                          <MetricCells metrics={model} />
                        </TableRow>
                        {modelExpanded &&
                          model.agents.map((agent) => (
                            <TableRow key={`${modelKey}:${agent.agentId}`}>
                              <TableCell className="pl-16">
                                <p className="font-medium">{agent.agentName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {[agent.hostname, ...agent.sources].join(
                                    " · ",
                                  )}
                                </p>
                              </TableCell>
                              <MetricCells metrics={agent} />
                            </TableRow>
                          ))}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell>{t("grandTotal")}</TableCell>
            <MetricCells metrics={totals} />
          </TableRow>
        </TableFooter>
      </Table>
    </Card>
  );
}

function MetricCells({ metrics }: { metrics: UsageMetrics }) {
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const currency = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (
    <>
      <TableCell className="text-right tabular-nums">
        {number.format(metrics.inputTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {number.format(metrics.outputTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {number.format(metrics.cacheCreationTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {number.format(metrics.cacheReadTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {number.format(metrics.totalTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {currency.format(metrics.totalCost)}
      </TableCell>
    </>
  );
}

function UsageEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className="border py-10">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
