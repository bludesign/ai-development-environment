"use client";

import {
  CCUSAGE_REPORT_JOB_KIND,
  parseCcusageJobResult,
  type CcusageReport,
} from "@ai-development-environment/agent-contract";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useMemo, useState } from "react";

import { JOB_FIELDS } from "@/components/agents/graphql-fields";
import type { Agent, AgentJob } from "@/components/agents/types";
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

import {
  aggregateUsage,
  filterUsageByDays,
  type UsageMetrics,
  type UsageRangeDays,
  type UsageReportSource,
} from "./aggregate-usage";
import { UsageCostChart } from "./usage-cost-chart";

const JOB_TIMEOUT_SECONDS = 120;
const COLLECTION_DEADLINE_MS = 150_000;
const RECONCILE_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set<AgentJob["status"]>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

type CollectionStatus =
  AgentJob["status"] | "QUEUING" | "OFFLINE" | "UNSUPPORTED" | "INVALID";

type AgentCollection = {
  agent: Agent;
  status: CollectionStatus;
  jobId?: string;
  error?: string;
};

type ReportsByAgent = Record<string, CcusageReport>;
type UsageRange = "ALL" | "7" | "30";

const RANGE_DAYS: Record<UsageRange, UsageRangeDays> = {
  ALL: null,
  "7": 7,
  "30": 30,
};

function terminal(status: CollectionStatus): boolean {
  return (
    status === "INVALID" || TERMINAL_STATUSES.has(status as AgentJob["status"])
  );
}

export function UsagePage() {
  const t = useTranslations("usage");
  const locale = useLocale();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [records, setRecords] = useState<AgentCollection[]>([]);
  const [reports, setReports] = useState<ReportsByAgent>({});
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [range, setRange] = useState<UsageRange>("ALL");

  useEffect(() => {
    let disposed = false;
    let reconcileTimer: number | undefined;
    let deadlineTimer: number | undefined;
    const unsubscribers: Array<() => void> = [];
    const jobs = new Map<string, { agent: Agent; job: AgentJob }>();
    const eligibleIds = new Set<string>();
    const completedIds = new Set<string>();

    const updateRecord = (
      agentId: string,
      update: Partial<Omit<AgentCollection, "agent">>,
    ) => {
      if (disposed) return;
      setRecords((current) =>
        current.map((record) =>
          record.agent.id === agentId ? { ...record, ...update } : record,
        ),
      );
    };

    const finishIfComplete = () => {
      if (
        !disposed &&
        eligibleIds.size > 0 &&
        completedIds.size === eligibleIds.size
      ) {
        setCollecting(false);
        if (reconcileTimer !== undefined) {
          window.clearInterval(reconcileTimer);
          reconcileTimer = undefined;
        }
        if (deadlineTimer !== undefined) {
          window.clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
      }
    };

    const applyJob = (agent: Agent, job: AgentJob) => {
      if (disposed || completedIds.has(agent.id)) return;
      jobs.set(agent.id, { agent, job });
      if (!terminal(job.status)) {
        updateRecord(agent.id, { jobId: job.id, status: job.status });
        return;
      }

      completedIds.add(agent.id);
      if (job.status === "SUCCEEDED") {
        try {
          const result = parseCcusageJobResult(job.result);
          setReports((current) => ({
            ...current,
            [agent.id]: result.report,
          }));
          updateRecord(agent.id, {
            jobId: job.id,
            status: "SUCCEEDED",
            error: undefined,
          });
        } catch (error) {
          updateRecord(agent.id, {
            jobId: job.id,
            status: "INVALID",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        updateRecord(agent.id, {
          jobId: job.id,
          status: job.status,
          error: job.error ?? undefined,
        });
      }
      finishIfComplete();
    };

    const reconcile = async (agent: Agent, jobId: string) => {
      try {
        const data = await controlPlaneRequest<{ agentJob: AgentJob | null }>(
          `query UsageJob($id: ID!) { agentJob(id: $id) { ${JOB_FIELDS} } }`,
          { id: jobId },
        );
        if (data.agentJob) applyJob(agent, data.agentJob);
      } catch {
        // The subscription or next reconciliation pass can still deliver the job.
      }
    };

    const run = async () => {
      setLoading(true);
      setCollecting(false);
      setLoadError(null);
      setReports({});
      setRecords([]);
      try {
        const data = await controlPlaneRequest<{ agents: Agent[] }>(
          "query UsageAgents { agents { id name hostname version osVersion architecture capabilities connectionStatus ipAddress lastSeenAt disconnectedAt createdAt } }",
        );
        if (disposed) return;

        const initialRecords = data.agents.map<AgentCollection>((agent) => {
          if (agent.connectionStatus !== "ONLINE") {
            return { agent, status: "OFFLINE" };
          }
          if (!agent.capabilities.includes(CCUSAGE_REPORT_JOB_KIND)) {
            return { agent, status: "UNSUPPORTED" };
          }
          eligibleIds.add(agent.id);
          return { agent, status: "QUEUING" };
        });
        setRecords(initialRecords);
        setLoading(false);
        if (eligibleIds.size === 0) return;
        setCollecting(true);

        const refreshId = createClientId();
        await Promise.all(
          data.agents
            .filter((agent) => eligibleIds.has(agent.id))
            .map(async (agent) => {
              try {
                const result = await controlPlaneRequest<{
                  createAgentJob: AgentJob;
                }>(
                  `mutation CollectUsage($input: CreateAgentJobInput!) { createAgentJob(input: $input) { ${JOB_FIELDS} } }`,
                  {
                    input: {
                      agentId: agent.id,
                      kind: CCUSAGE_REPORT_JOB_KIND,
                      payload: {},
                      idempotencyKey: `ccusage:${refreshId}`,
                      timeoutSeconds: JOB_TIMEOUT_SECONDS,
                    },
                  },
                );
                if (disposed) return;
                const job = result.createAgentJob;
                jobs.set(agent.id, { agent, job });
                updateRecord(agent.id, { jobId: job.id, status: job.status });
                const unsubscribe = controlPlaneSubscriptions().subscribe<{
                  agentJobChanged: AgentJob;
                }>(
                  {
                    query: `subscription UsageJobChanged($jobId: ID!) { agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} } }`,
                    variables: { jobId: job.id },
                  },
                  {
                    next: (value) => {
                      if (value.data?.agentJobChanged) {
                        applyJob(agent, value.data.agentJobChanged);
                      }
                    },
                    error: () => undefined,
                    complete: () => undefined,
                  },
                );
                unsubscribers.push(unsubscribe);
                applyJob(agent, job);
                await reconcile(agent, job.id);
              } catch (error) {
                if (disposed) return;
                completedIds.add(agent.id);
                updateRecord(agent.id, {
                  status: "FAILED",
                  error: error instanceof Error ? error.message : String(error),
                });
                finishIfComplete();
              }
            }),
        );
        if (disposed) return;
        finishIfComplete();
        if (completedIds.size < eligibleIds.size) {
          reconcileTimer = window.setInterval(() => {
            for (const [agentId, entry] of jobs) {
              if (!completedIds.has(agentId)) {
                void reconcile(entry.agent, entry.job.id);
              }
            }
          }, RECONCILE_INTERVAL_MS);
          deadlineTimer = window.setTimeout(() => {
            for (const agentId of eligibleIds) {
              if (completedIds.has(agentId)) continue;
              completedIds.add(agentId);
              const entry = jobs.get(agentId);
              updateRecord(agentId, {
                status: "TIMED_OUT",
                error: undefined,
              });
              if (entry) {
                void controlPlaneRequest(
                  "mutation CancelUsageJob($jobId: ID!) { cancelAgentJob(jobId: $jobId) { id } }",
                  { jobId: entry.job.id },
                ).catch(() => undefined);
              }
            }
            finishIfComplete();
          }, COLLECTION_DEADLINE_MS);
        }
      } catch (error) {
        if (disposed) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
        setCollecting(false);
      }
    };

    void run();
    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      if (reconcileTimer !== undefined) window.clearInterval(reconcileTimer);
      if (deadlineTimer !== undefined) window.clearTimeout(deadlineTimer);
    };
  }, [refreshGeneration]);

  const reportSources = useMemo<UsageReportSource[]>(
    () =>
      records.flatMap((record) => {
        const report = reports[record.agent.id];
        return report ? [{ agent: record.agent, report }] : [];
      }),
    [records, reports],
  );
  const allUsage = useMemo(
    () => aggregateUsage(reportSources),
    [reportSources],
  );
  const usage = useMemo(
    () => filterUsageByDays(allUsage, RANGE_DAYS[range]),
    [allUsage, range],
  );
  const successful = records.filter((record) => record.status === "SUCCEEDED");
  const eligible = records.filter(
    (record) => record.status !== "OFFLINE" && record.status !== "UNSUPPORTED",
  );
  const offline = records.filter(
    (record) => record.agent.connectionStatus === "OFFLINE",
  );
  const unsupported = records.filter(
    (record) => !record.agent.capabilities.includes(CCUSAGE_REPORT_JOB_KIND),
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
          <div
            aria-label={t("rangeLabel")}
            className="flex items-center gap-1"
            role="group"
          >
            {(
              [
                ["ALL", t("allData")],
                ["7", t("last7Days")],
                ["30", t("last30Days")],
              ] as const
            ).map(([value, label]) => (
              <Button
                aria-pressed={range === value}
                key={value}
                onClick={() => setRange(value)}
                size="sm"
                type="button"
                variant={range === value ? "default" : "outline"}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            disabled={loading || collecting}
            onClick={() => setRefreshGeneration((current) => current + 1)}
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
          eligibleCount={eligible.length}
          failures={failures}
          offline={offline}
          successfulCount={successful.length}
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
      ) : successful.length > 0 && allUsage.days.length === 0 ? (
        <UsageEmpty
          title={t("zeroUsage")}
          description={t("zeroUsageDescription")}
        />
      ) : successful.length > 0 && usage.days.length === 0 ? (
        <UsageEmpty
          title={t("noUsageInRange")}
          description={t("noUsageInRangeDescription")}
        />
      ) : successful.length > 0 ? (
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
  days: ReturnType<typeof aggregateUsage>["days"];
  locale: string;
  totals: UsageMetrics;
}) {
  const t = useTranslations("usage");
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
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
                        {dateFormatter.format(
                          new Date(`${day.period}T00:00:00Z`),
                        )}
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
                    const modelKey = `${day.period}:${model.modelName}`;
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
                                { model: model.modelName },
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
                                {model.modelName}
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
