"use client";

import { RefreshCw, Search, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { ToolCallAuditView } from "./types";

const AUDIT_FIELDS = `
  id correlationId caller source groupId toolName argumentsSha256 resultStatus
  durationMs startedAt finishedAt
`;

function statusVariant(status: string) {
  if (status === "SUCCEEDED") return "success" as const;
  if (status === "FAILED") return "destructive" as const;
  return "secondary" as const;
}

export function ToolAuditTable() {
  const t = useTranslations("tools");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [audits, setAudits] = useState<ToolCallAuditView[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        toolCallAudits: ToolCallAuditView[];
      }>(
        `query ToolCallAudits { toolCallAudits(first: 200) { ${AUDIT_FIELDS} } }`,
      );
      setAudits(data.toolCallAudits);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const clear = async () => {
    setClearing(true);
    try {
      await controlPlaneRequest(
        "mutation ClearToolCallAudits { clearToolCallAudits { count } }",
      );
      setQuery("");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setClearing(false);
    }
  };

  const visibleAudits = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return audits;
    return audits.filter((audit) =>
      [
        audit.id,
        audit.correlationId,
        audit.caller,
        audit.source,
        audit.groupId,
        audit.toolName,
        audit.argumentsSha256,
        audit.resultStatus,
      ].some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [audits, query]);

  const statusLabels: Record<string, string> = {
    FAILED: t("auditFailed"),
    RUNNING: t("auditRunning"),
    SUCCEEDED: t("auditSucceeded"),
  };
  const sourceLabels: Record<string, string> = {
    TOOLS_PAGE: t("auditToolsPage"),
    WORKFLOW: t("auditWorkflow"),
  };
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale),
    [locale],
  );
  const hasCompletedAudits = audits.some(
    (audit) => audit.resultStatus !== "RUNNING",
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("auditTitle")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("auditDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={loading || clearing}
            onClick={() => void load()}
            type="button"
            variant="outline"
          >
            {loading ? <Spinner /> : <RefreshCw />}
            {t("auditRefresh")}
          </Button>
          <ConfirmationDialog
            actionLabel={t("auditClearAction")}
            cancelLabel={tc("cancel")}
            description={t("auditClearDescription")}
            onConfirm={clear}
            title={t("auditClearTitle")}
            trigger={
              <Button
                disabled={loading || clearing || !hasCompletedAudits}
                type="button"
                variant="destructive"
              >
                {clearing ? <Spinner /> : <Trash2 />}
                {t("auditClear")}
              </Button>
            }
          />
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t("auditSearch")}
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("auditSearchPlaceholder")}
          type="search"
          value={query}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 overflow-hidden py-0">
        {loading && audits.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner /> {t("auditLoading")}
          </div>
        ) : visibleAudits.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {query.trim() ? t("auditNoMatches") : t("auditEmpty")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("auditStarted")}</TableHead>
                <TableHead>{t("auditTool")}</TableHead>
                <TableHead>{t("auditStatus")}</TableHead>
                <TableHead>{t("auditSource")}</TableHead>
                <TableHead>{t("auditCaller")}</TableHead>
                <TableHead>{t("auditGroup")}</TableHead>
                <TableHead>{t("auditDuration")}</TableHead>
                <TableHead>{t("auditFinished")}</TableHead>
                <TableHead>{t("auditCorrelationId")}</TableHead>
                <TableHead>{t("auditArgumentsHash")}</TableHead>
                <TableHead>{t("auditId")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleAudits.map((audit) => (
                <TableRow key={audit.id}>
                  <TableCell>
                    <DateTime value={audit.startedAt} />
                  </TableCell>
                  <TableCell className="font-mono text-xs font-medium">
                    {audit.toolName}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(audit.resultStatus)}>
                      {statusLabels[audit.resultStatus] ?? audit.resultStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {sourceLabels[audit.source] ?? audit.source}
                    </Badge>
                  </TableCell>
                  <TableCell>{audit.caller}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {audit.groupId}
                  </TableCell>
                  <TableCell>
                    {audit.durationMs === null
                      ? "—"
                      : `${numberFormatter.format(audit.durationMs)} ms`}
                  </TableCell>
                  <TableCell>
                    {audit.finishedAt ? (
                      <DateTime value={audit.finishedAt} />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <code
                      className="block max-w-48 truncate text-xs"
                      title={audit.correlationId}
                    >
                      {audit.correlationId}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code
                      className="block max-w-48 truncate text-xs"
                      title={audit.argumentsSha256}
                    >
                      {audit.argumentsSha256}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code
                      className="block max-w-48 truncate text-xs"
                      title={audit.id}
                    >
                      {audit.id}
                    </code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
