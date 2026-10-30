"use client";

import { RefreshCw, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";

type Entry = {
  id: string;
  repository: string;
  memberCount: number;
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
};
const FIELDS = "id repository memberCount fetchedAt expiresAt stale";
export function ReviewerDirectoryCacheCard({
  refreshKey = "",
}: {
  refreshKey?: string;
}) {
  const t = useTranslations("reviewers");
  const locale = useLocale();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void controlPlaneRequest<{ gitlabReviewerDirectories: Entry[] }>(
      `query GitLabReviewerDirectories { gitlabReviewerDirectories { ${FIELDS} } }`,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setEntries(data.gitlabReviewerDirectories);
      })
      .catch((value: unknown) => {
        if (!controller.signal.aborted) setError(String(value));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [revision, refreshKey]);
  async function update(id: string, remove: boolean) {
    setBusy(id);
    setError(null);
    try {
      await controlPlaneRequest(
        remove
          ? `mutation DeleteGitLabReviewerDirectory($id: ID!) { deleteGitLabReviewerDirectory(projectId: $id) }`
          : `mutation RefreshGitLabReviewerDirectory($id: ID!) { refreshGitLabReviewerDirectory(projectId: $id) { id } }`,
        { id },
      );
      setRevision((value) => value + 1);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-5" />
          {t("directoryTitle")}
        </CardTitle>
        <CardDescription>{t("directoryDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {busy === "loading" && <Spinner />}
        {!busy && !entries.length && (
          <p className="text-sm text-muted-foreground">{t("directoryEmpty")}</p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">
                {entry.repository} ·{" "}
                {t("directoryMembers", { count: entry.memberCount })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("directoryFetched", {
                  date: formatDateValue(entry.fetchedAt, "short", { locale }),
                })}{" "}
                ·{" "}
                {t("directoryExpires", {
                  date: formatDateValue(entry.expiresAt, "short", { locale }),
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                {t(entry.stale ? "directoryStale" : "directoryFresh")}
              </Badge>
              <Button
                aria-label={t("directoryRefresh")}
                disabled={busy !== null}
                size="icon-sm"
                variant="ghost"
                onClick={() => void update(entry.id, false)}
              >
                {busy === entry.id ? <Spinner /> : <RefreshCw />}
              </Button>
              <Button
                aria-label={t("directoryDelete")}
                disabled={busy !== null}
                size="icon-sm"
                variant="ghost"
                onClick={() => void update(entry.id, true)}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
