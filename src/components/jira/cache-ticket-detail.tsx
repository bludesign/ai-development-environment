"use client";

import { ArrowLeft, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export function JiraCacheTicketDetailPage({ issueKey }: { issueKey: string }) {
  const t = useTranslations("jiraCacheDetail");
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
    if (!window.confirm(t("confirmDelete", { issueKey }))) return;
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
          <Button
            disabled={busy || !ticket}
            onClick={() => void remove()}
            variant="destructive"
          >
            <Trash2 />
            {t("delete")}
          </Button>
        </div>
      </div>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {t("loading")}
        </div>
      ) : !ticket ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t("notFound")}
        </div>
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
              value={date(ticket.detailFetchedAt)}
            />
            <Metadata
              label={t("commentsFetched")}
              value={date(ticket.commentsFetchedAt)}
            />
          </div>
          <JsonPanel title={t("summaryData")} value={ticket.summaryData} />
          <JsonPanel title={t("detailData")} value={ticket.detailData} />
          <JsonPanel title={t("commentsData")} value={ticket.commentsData} />
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b p-4">
              <h2 className="font-semibold">{t("relatedEntries")}</h2>
            </div>
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
                      <TableCell>{date(entry.fetchedAt)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {entry.id}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function Metadata({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  const t = useTranslations("jiraCacheDetail");
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b p-4">
        <h2 className="font-semibold">{title}</h2>
      </div>
      {value === null ? (
        <p className="p-6 text-sm text-muted-foreground">{t("notFetched")}</p>
      ) : (
        <pre className="max-h-[36rem] overflow-auto p-4 text-xs leading-5">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </section>
  );
}
