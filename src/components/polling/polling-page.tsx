"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { Link } from "@/i18n/navigation";

type PollingOperation = {
  id: string;
  kind: string;
  runtime: "SERVER" | "AGENT";
  status: "DISABLED" | "HEALTHY" | "RUNNING" | "STALE" | "ERROR";
  enabled: boolean;
  cadenceSeconds: number | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSucceededAt: string | null;
  nextScheduledAt: string | null;
  durationMs: number | null;
  lastError: string | null;
  details: Record<string, unknown>;
};

const FIELDS = `
  id kind runtime status enabled cadenceSeconds lastStartedAt lastCompletedAt
  lastSucceededAt nextScheduledAt durationMs lastError details
`;

function statusVariant(status: PollingOperation["status"]) {
  if (status === "HEALTHY") return "secondary" as const;
  if (status === "ERROR") return "destructive" as const;
  return "outline" as const;
}

function detailText(details: Record<string, unknown>): string {
  return Object.entries(details)
    .filter(
      ([key, value]) =>
        key !== "agentId" &&
        key !== "agentName" &&
        ["string", "number", "boolean"].includes(typeof value),
    )
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

function OperationsTable({
  operations,
  showAgent = false,
}: {
  operations: PollingOperation[];
  showAgent?: boolean;
}) {
  const t = useTranslations("polling");
  if (operations.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("operation")}</TableHead>
            {showAgent && <TableHead>{t("agent")}</TableHead>}
            <TableHead>{t("status")}</TableHead>
            <TableHead>{t("cadence")}</TableHead>
            <TableHead>{t("lastStarted")}</TableHead>
            <TableHead>{t("lastCompleted")}</TableHead>
            <TableHead>{t("nextPoll")}</TableHead>
            <TableHead>{t("details")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {operations.map((operation) => (
            <TableRow key={operation.id}>
              <TableCell>
                <p className="font-medium">
                  {t(`kinds.${operation.kind}` as never)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {operation.runtime === "SERVER"
                    ? t("serverRuntime")
                    : t("agentRuntime")}
                </p>
              </TableCell>
              {showAgent && (
                <TableCell>
                  {typeof operation.details.agentId === "string" &&
                  typeof operation.details.agentName === "string" ? (
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      href={`/agents/${operation.details.agentId}`}
                    >
                      {operation.details.agentName}
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
              )}
              <TableCell>
                <Badge variant={statusVariant(operation.status)}>
                  {t(`statuses.${operation.status}` as never)}
                </Badge>
                {operation.lastError && (
                  <p className="mt-1 max-w-72 text-xs text-destructive">
                    {operation.lastError}
                  </p>
                )}
              </TableCell>
              <TableCell>
                {operation.cadenceSeconds
                  ? t("everySeconds", {
                      seconds: operation.cadenceSeconds,
                    })
                  : "—"}
              </TableCell>
              <TableCell>
                {operation.lastStartedAt ? (
                  <DateTime kind="relative" value={operation.lastStartedAt} />
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                {operation.lastCompletedAt ? (
                  <>
                    <DateTime
                      kind="relative"
                      value={operation.lastCompletedAt}
                    />
                    {operation.durationMs !== null && (
                      <p className="text-xs text-muted-foreground">
                        {t("duration", { milliseconds: operation.durationMs })}
                      </p>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                {operation.nextScheduledAt ? (
                  <DateTime kind="relative" value={operation.nextScheduledAt} />
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="max-w-md text-xs text-muted-foreground">
                {detailText(operation.details) || "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PollingPage() {
  const t = useTranslations("polling");
  const [operations, setOperations] = useState<PollingOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        pollingOperations: PollingOperation[];
      }>(`query PollingOperations { pollingOperations { ${FIELDS} } }`);
      setOperations(data.pollingOperations);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const client = controlPlaneSubscriptions();
    const subscriptions = [
      client.subscribe<{ pollingOperationChanged: string }>(
        { query: "subscription { pollingOperationChanged }" },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
      client.subscribe<{ agentChanged: { id: string } }>(
        { query: "subscription { agentChanged { id } }" },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
      client.subscribe<{
        codebaseOverviewChanged: { codebaseId: string | null };
      }>(
        {
          query:
            "subscription { codebaseOverviewChanged { codebaseId repositoryId } }",
        },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    ];
    return () => {
      window.clearTimeout(initial);
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [load]);

  const grouped = useMemo(
    () => ({
      server: operations.filter((operation) => operation.runtime === "SERVER"),
      agent: operations.filter((operation) => operation.runtime === "AGENT"),
    }),
    [operations],
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
        <Button onClick={() => void load()} variant="outline">
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {t("refresh")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && operations.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("serverTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <OperationsTable operations={grouped.server} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("agentTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <OperationsTable operations={grouped.agent} showAgent />
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
