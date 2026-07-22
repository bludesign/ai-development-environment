"use client";

import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/ui/date-time";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraCachedTicketDetail } from "@/services/jira/types";

const DETAIL_FIELDS =
  "issueKey projectKey summary status coverage stale summaryFetchedAt detailFetchedAt commentsFetchedAt updatedAt summaryData detailData commentsData cacheEntries { id operation fetchedAt }";

export function JiraCacheTicketDetailPage({ issueKey }: { issueKey: string }) {
  const t = useTranslations("jiraCacheDetail");
  const tc = useTranslations("common");
  const router = useRouter();
  const [ticket, setTicket] = useState<JiraCachedTicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        jiraCachedTicket: JiraCachedTicketDetail | null;
      }>(
        `query CachedJiraTicket($issueKey: ID!) { jiraCachedTicket(issueKey: $issueKey) { ${DETAIL_FIELDS} } }`,
        { issueKey },
      );
      setTicket(data.jiraCachedTicket);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [issueKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        "mutation RefreshCachedTicket($issueKey: ID!) { refreshJiraCachedTicket(issueKey: $issueKey) { key } }",
        { issueKey },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        "mutation DeleteCachedTicket($issueKey: ID!) { deleteJiraCachedTicket(issueKey: $issueKey) }",
        { issueKey },
      );
      router.replace("/jira/cache");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/jira/cache">
            <ArrowLeft />
            {t("back")}
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{issueKey}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {ticket?.summary ?? t("description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={busy || !ticket}
            onClick={() => void refresh()}
            variant="outline"
          >
            <RefreshCw className={busy ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
          <ConfirmationDialog
            actionLabel={t("delete")}
            cancelLabel={tc("cancel")}
            description={tc("cannotBeUndone")}
            onConfirm={remove}
            title={t("confirmDelete", { issueKey })}
            trigger={
              <Button disabled={busy || !ticket} variant="destructive">
                <Trash2 />
                {t("delete")}
              </Button>
            }
          />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </div>
      ) : !ticket ? (
        <Empty className="border py-10">
          <EmptyHeader>
            <EmptyDescription>{t("notFound")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metadata
              label={t("coverage")}
              value={<Badge>{ticket.coverage}</Badge>}
            />
            <Metadata
              label={t("freshness")}
              value={
                <Badge
                  className={
                    ticket.stale
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  }
                >
                  {ticket.stale ? t("stale") : t("fresh")}
                </Badge>
              }
            />
            <Metadata
              label={t("detailFetched")}
              value={<DateTime value={ticket.detailFetchedAt} />}
            />
            <Metadata
              label={t("commentsFetched")}
              value={<DateTime value={ticket.commentsFetchedAt} />}
            />
          </div>
          <JsonPanel title={t("summaryData")} value={ticket.summaryData} />
          <JsonPanel title={t("detailData")} value={ticket.detailData} />
          <JsonPanel title={t("commentsData")} value={ticket.commentsData} />
          <Card className="gap-0 py-0">
            <CardHeader>
              <CardTitle>{t("relatedEntries")}</CardTitle>
            </CardHeader>
            {ticket.cacheEntries.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">
                {t("noEntries")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("operation")}</TableHead>
                    <TableHead>{t("fetchedAt")}</TableHead>
                    <TableHead>{t("entryId")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ticket.cacheEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        {entry.operation}
                      </TableCell>
                      <TableCell>
                        <DateTime value={entry.fetchedAt} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {entry.id}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </section>
  );
}

function Metadata({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-1 text-sm font-medium">{value}</div>
      </CardContent>
    </Card>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  const t = useTranslations("jiraCacheDetail");
  return (
    <Card className="gap-0 py-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {value === null ? (
        <p className="p-6 text-sm text-muted-foreground">{t("notFetched")}</p>
      ) : (
        <pre className="max-h-[36rem] overflow-auto p-4 text-xs leading-5">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </Card>
  );
}
