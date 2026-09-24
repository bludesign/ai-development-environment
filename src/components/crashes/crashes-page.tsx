"use client";

import { Bug, Search, Trash2, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { SelectAllCheckbox } from "@/components/common/select-all-checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOwnedRead } from "@/hooks/use-owned-read";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { isRowActivation, rowLinkClass } from "@/lib/row-activation";

import { CrashStatusBadge } from "./crash-status-badge";
import { CrashesShell } from "./crashes-shell";
import { frameLocation } from "./frames-table";
import { CRASHES_QUERY, DELETE_CRASHES_MUTATION } from "./graphql";
import {
  CRASH_REPORT_STATUSES,
  type CrashReportStatus,
  type CrashSummary,
} from "./types";
import { useCrashLiveReload } from "./use-crash-live-reload";

const ALL = "all";
const PAGE_SIZE = 50;

type CrashesData = {
  crashReports: {
    nodes: CrashSummary[];
    nextCursor: string | null;
    totalCount: number;
    matchingCount: number;
  };
  crashFacets: {
    apps: { bundleId: string; appName: string | null; count: number }[];
    appVersions: string[];
  };
};

export function crashVersion(crash: {
  appVersion: string | null;
  buildVersion: string | null;
}): string {
  if (!crash.appVersion) return crash.buildVersion ?? "—";
  return crash.buildVersion
    ? `${crash.appVersion} (${crash.buildVersion})`
    : crash.appVersion;
}

/** Table of crash reports, reused by the dSYM and crash detail pages. */
export function CrashTable({
  crashes,
  selected,
  onSelectedChange,
}: {
  crashes: CrashSummary[];
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
}) {
  const t = useTranslations("crashes");
  const router = useRouter();
  const selectable = Boolean(selected && onSelectedChange);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-8">
              <SelectAllCheckbox
                ids={crashes.map((crash) => crash.id)}
                label={t("selectAll")}
                onChange={onSelectedChange!}
                selected={selected!}
              />
            </TableHead>
          ) : null}
          <TableHead>{t("status")}</TableHead>
          <TableHead>{t("app")}</TableHead>
          <TableHead>{t("version")}</TableHead>
          <TableHead>{t("crash")}</TableHead>
          <TableHead>{t("device")}</TableHead>
          <TableHead>{t("crashedAt")}</TableHead>
          <TableHead>{t("received")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {crashes.map((crash) => {
          const href = `/crashes/${encodeURIComponent(crash.id)}`;
          const location = crash.topAppFrame
            ? frameLocation(crash.topAppFrame)
            : null;
          return (
            <TableRow
              className="cursor-pointer"
              key={crash.id}
              onClick={(event) => {
                if (isRowActivation(event)) router.push(href);
              }}
            >
              {selectable ? (
                <TableCell>
                  <Checkbox
                    aria-label={t("selectCrash")}
                    checked={selected!.has(crash.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked === true) next.add(crash.id);
                      else next.delete(crash.id);
                      onSelectedChange!(next);
                    }}
                  />
                </TableCell>
              ) : null}
              <TableCell>
                <CrashStatusBadge
                  status={crash.status}
                  title={crash.statusMessage}
                />
              </TableCell>
              <TableCell className="max-w-56">
                <Link className={rowLinkClass} href={href}>
                  <span className="font-medium">
                    {crash.appName ?? crash.filename}
                  </span>
                </Link>
                {crash.bundleId ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {crash.bundleId}
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {crashVersion(crash)}
              </TableCell>
              <TableCell className="max-w-md">
                <p
                  className="truncate font-medium"
                  title={crash.signatureTitle}
                >
                  {crash.signatureTitle}
                </p>
                {location ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {location}
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <p>{crash.deviceModel ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {crash.osVersion ?? ""}
                </p>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <DateTime value={crash.crashedAt} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <DateTime value={crash.createdAt} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function CrashesPage() {
  const t = useTranslations("crashes");
  const searchParams = useSearchParams();
  const [signature, setSignature] = useState<string | null>(
    searchParams.get("signature"),
  );
  const [data, setData] = useState<CrashesData | null>(null);
  const [extra, setExtra] = useState<CrashSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(ALL);
  const [bundleId, setBundleId] = useState<string>(ALL);
  const [appVersion, setAppVersion] = useState<string>(ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filter = useMemo(
    () => ({
      search: search || null,
      status: status === ALL ? null : status,
      bundleId: bundleId === ALL ? null : bundleId,
      appVersion: appVersion === ALL ? null : appVersion,
      signature,
    }),
    [appVersion, bundleId, search, signature, status],
  );

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await controlPlaneRequest<CrashesData>(
          CRASHES_QUERY,
          { filter, first: PAGE_SIZE },
          { signal },
        );
        if (signal.aborted) return;
        setData(next);
        setExtra([]);
        setCursor(next.crashReports.nextCursor);
        setError(null);
      } catch (value) {
        if (!signal.aborted) {
          setError(value instanceof Error ? value.message : String(value));
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [filter],
  );
  const load = useOwnedRead(fetchData);
  useCrashLiveReload(["crashes"], load);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await controlPlaneRequest<CrashesData>(CRASHES_QUERY, {
        filter,
        first: PAGE_SIZE,
        after: cursor,
      });
      setExtra((current) => [...current, ...next.crashReports.nodes]);
      setCursor(next.crashReports.nextCursor);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingMore(false);
    }
  }

  async function deleteSelected() {
    try {
      await controlPlaneRequest(DELETE_CRASHES_MUTATION, {
        ids: [...selected],
      });
      setSelected(new Set());
      setConfirmDelete(false);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  const crashes = [...(data?.crashReports.nodes ?? []), ...extra];
  const filtered =
    Boolean(search) ||
    Boolean(signature) ||
    status !== ALL ||
    bundleId !== ALL ||
    appVersion !== ALL;

  return (
    <CrashesShell onChanged={() => void load()}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:max-w-sm md:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("searchCrashes")}
            className="pl-8"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t("searchCrashes")}
            value={searchInput}
          />
        </div>
        <Select onValueChange={setStatus} value={status}>
          <SelectTrigger aria-label={t("status")} className="md:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
            {CRASH_REPORT_STATUSES.map((value: CrashReportStatus) => (
              <SelectItem key={value} value={value}>
                {t(`statuses.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select onValueChange={setBundleId} value={bundleId}>
          <SelectTrigger aria-label={t("app")} className="md:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allApps")}</SelectItem>
            {data?.crashFacets.apps.map((app) => (
              <SelectItem key={app.bundleId} value={app.bundleId}>
                {app.appName ?? app.bundleId} ({app.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select onValueChange={setAppVersion} value={appVersion}>
          <SelectTrigger aria-label={t("version")} className="md:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allVersions")}</SelectItem>
            {data?.crashFacets.appVersions.map((version) => (
              <SelectItem key={version} value={version}>
                {version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {signature ? (
          <Badge className="gap-1" variant="secondary">
            {t("signatureFilter")}
            <button
              aria-label={t("clearSignatureFilter")}
              onClick={() => setSignature(null)}
              type="button"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ) : null}
        {selected.size ? (
          <ConfirmationDialog
            actionLabel={t("delete")}
            cancelLabel={t("cancel")}
            description={t("deleteCrashesDescription", {
              count: selected.size,
            })}
            onConfirm={deleteSelected}
            onOpenChange={setConfirmDelete}
            open={confirmDelete}
            title={t("deleteCrashesTitle", { count: selected.size })}
            trigger={
              <Button className="md:ml-auto" variant="outline">
                <Trash2 /> {t("deleteSelected", { count: selected.size })}
              </Button>
            }
          />
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : crashes.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bug />
            </EmptyMedia>
            <EmptyTitle>
              {filtered ? t("noMatchingCrashes") : t("noCrashes")}
            </EmptyTitle>
            <EmptyDescription>
              {filtered
                ? t("noMatchingCrashesDescription")
                : t("noCrashesDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <CrashTable
            crashes={crashes}
            onSelectedChange={setSelected}
            selected={selected}
          />
          <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
            <span>
              {t("showingCount", {
                shown: crashes.length,
                total: data?.crashReports.matchingCount ?? crashes.length,
              })}
            </span>
            {cursor ? (
              <Button
                disabled={loadingMore}
                onClick={() => void loadMore()}
                size="sm"
                variant="outline"
              >
                {loadingMore ? <Spinner /> : null}
                {t("loadMore")}
              </Button>
            ) : null}
          </div>
        </Card>
      )}
    </CrashesShell>
  );
}
