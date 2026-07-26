"use client";

import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitHubCachedEntryDetail } from "@/services/github/types";

const DETAIL_FIELDS =
  "id authentication operation endpoint fetchedAt pointCost stale query variables response";

export function GitHubCacheEntryDetailPage({ id }: { id: string }) {
  const t = useTranslations("githubCacheDetail");
  const tc = useTranslations("common");
  const router = useRouter();
  const [entry, setEntry] = useState<GitHubCachedEntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        githubCachedEntry: GitHubCachedEntryDetail | null;
      }>(
        `query GitHubCachedEntry($id: ID!) { githubCachedEntry(id: $id) { ${DETAIL_FIELDS} } }`,
        { id },
      );
      setEntry(data.githubCachedEntry);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        "mutation RefreshGitHubCachedEntry($id: ID!) { refreshGitHubCachedEntry(id: $id) { id } }",
        { id },
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
        "mutation DeleteGitHubCachedEntry($id: ID!) { deleteGitHubCachedEntry(id: $id) }",
        { id },
      );
      router.replace("/github-cache");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/github-cache">
            <ArrowLeft />
            {t("back")}
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {entry?.operation ?? t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {entry?.endpoint ?? t("description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={busy || !entry}
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
            title={t("confirmDelete")}
            trigger={
              <Button disabled={busy || !entry} variant="destructive">
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
      ) : !entry ? (
        <Empty className="border py-10">
          <EmptyHeader>
            <EmptyDescription>{t("notFound")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metadata
              label={t("authentication")}
              value={entry.authentication}
            />
            <Metadata
              label={t("freshness")}
              value={
                <Badge
                  className={
                    entry.stale
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  }
                >
                  {entry.stale ? t("stale") : t("fresh")}
                </Badge>
              }
            />
            <Metadata label={t("lastCost")} value={entry.pointCost ?? "—"} />
            <Metadata
              label={t("fetchedAt")}
              value={<DateTime value={entry.fetchedAt} />}
            />
          </div>
          <TextPanel title={t("query")} value={entry.query} />
          <JsonPanel title={t("variables")} value={entry.variables} />
          <JsonPanel title={t("response")} value={entry.response} />
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

function TextPanel({ title, value }: { title: string; value: string }) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap p-4 text-xs leading-5">
        {value}
      </pre>
    </Card>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <pre className="max-h-[36rem] overflow-auto p-4 text-xs leading-5">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Card>
  );
}
