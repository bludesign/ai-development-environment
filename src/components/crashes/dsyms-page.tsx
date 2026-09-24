"use client";

import { FileArchive, RotateCw, Search, Trash2, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { SelectAllCheckbox } from "@/components/common/select-all-checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

import { DsymUploadStatusBadge } from "./crash-status-badge";
import { CrashesShell } from "./crashes-shell";
import {
  DELETE_DSYM_UPLOAD_MUTATION,
  DELETE_DSYMS_MUTATION,
  DSYMS_QUERY,
  RETRY_DSYM_UPLOAD_MUTATION,
} from "./graphql";
import type { DsymSummary, DsymUpload } from "./types";
import { formatBytes } from "./uploads";
import { useCrashLiveReload } from "./use-crash-live-reload";

const ALL = "all";
const PAGE_SIZE = 50;

type DsymsData = {
  dsyms: {
    nodes: DsymSummary[];
    nextCursor: string | null;
    totalCount: number;
    matchingCount: number;
  };
  dsymProjects: string[];
  dsymUploads: DsymUpload[];
};

export function dsymVersion(dsym: {
  shortVersion: string | null;
  bundleVersion: string | null;
}): string {
  if (!dsym.shortVersion) return dsym.bundleVersion ?? "—";
  return dsym.bundleVersion
    ? `${dsym.shortVersion} (${dsym.bundleVersion})`
    : dsym.shortVersion;
}

export function DsymBuildLink({ upload }: { upload: DsymUpload }) {
  if (upload.linkedBuildId) {
    return (
      <Link
        className={rowLinkClass}
        href={`/builds/${encodeURIComponent(upload.linkedBuildId)}`}
      >
        <span className="font-mono text-xs">
          {upload.buildId ?? upload.linkedBuildId.slice(0, 8)}
        </span>
      </Link>
    );
  }
  return <span className="font-mono text-xs">{upload.buildId ?? "—"}</span>;
}

export function DsymSourceBadge({ source }: { source: DsymUpload["source"] }) {
  const t = useTranslations("crashes");
  return <Badge variant="outline">{t(`sources.${source}`)}</Badge>;
}

/** Table of dSYMs, reused by the crash and dSYM detail pages. */
export function DsymTable({
  dsyms,
  selected,
  onSelectedChange,
}: {
  dsyms: DsymSummary[];
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
}) {
  const t = useTranslations("crashes");
  const locale = useLocale();
  const router = useRouter();
  const selectable = Boolean(selected && onSelectedChange);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-8">
              <SelectAllCheckbox
                ids={dsyms.map((dsym) => dsym.id)}
                label={t("selectAll")}
                onChange={onSelectedChange!}
                selected={selected!}
              />
            </TableHead>
          ) : null}
          <TableHead>{t("dsym")}</TableHead>
          <TableHead>{t("uuids")}</TableHead>
          <TableHead>{t("version")}</TableHead>
          <TableHead>{t("projectName")}</TableHead>
          <TableHead>{t("buildId")}</TableHead>
          <TableHead>{t("source")}</TableHead>
          <TableHead className="text-right">{t("size")}</TableHead>
          <TableHead className="text-right">{t("crashes")}</TableHead>
          <TableHead>{t("uploaded")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {dsyms.map((dsym) => {
          const href = `/crashes/dsyms/${encodeURIComponent(dsym.id)}`;
          return (
            <TableRow
              className="cursor-pointer"
              key={dsym.id}
              onClick={(event) => {
                if (isRowActivation(event)) router.push(href);
              }}
            >
              {selectable ? (
                <TableCell>
                  <Checkbox
                    aria-label={t("selectDsym")}
                    checked={selected!.has(dsym.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked === true) next.add(dsym.id);
                      else next.delete(dsym.id);
                      onSelectedChange!(next);
                    }}
                  />
                </TableCell>
              ) : null}
              <TableCell className="max-w-64">
                <Link className={rowLinkClass} href={href}>
                  <span className="font-medium">{dsym.bundleName}</span>
                </Link>
                {dsym.bundleIdentifier ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {dsym.bundleIdentifier}
                  </p>
                ) : null}
              </TableCell>
              <TableCell>
                {dsym.slices.map((slice) => (
                  <p
                    className="font-mono text-xs whitespace-nowrap"
                    key={slice.id}
                  >
                    {slice.uuid}{" "}
                    <span className="text-muted-foreground">{slice.arch}</span>
                  </p>
                ))}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {dsymVersion(dsym)}
              </TableCell>
              <TableCell>{dsym.upload.projectName ?? "—"}</TableCell>
              <TableCell>
                <DsymBuildLink upload={dsym.upload} />
              </TableCell>
              <TableCell>
                <DsymSourceBadge source={dsym.upload.source} />
              </TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                {formatBytes(dsym.dwarfSizeBytes, locale)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {dsym.crashCount}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <DateTime value={dsym.createdAt} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function PendingUploads({
  uploads,
  onChanged,
}: {
  uploads: DsymUpload[];
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("crashes");
  const locale = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!uploads.length) return null;

  async function run(id: string, mutation: string) {
    setBusy(id);
    setError(null);
    try {
      await controlPlaneRequest(mutation, { id });
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>{t("pendingUploads")}</CardTitle>
        <CardDescription>{t("pendingUploadsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <ul className="divide-y rounded-md border text-sm">
          {uploads.map((upload) => (
            <li
              className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
              key={upload.id}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{upload.filename}</span>
                  <DsymUploadStatusBadge status={upload.status} />
                  <DsymSourceBadge source={upload.source} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {upload.status === "UPLOADING"
                    ? t("uploadProgress", {
                        received: formatBytes(upload.uploadOffset, locale),
                        total: formatBytes(upload.sizeBytes, locale),
                      })
                    : (upload.error ?? upload.projectName ?? "")}
                </p>
              </div>
              <div className="flex gap-2">
                {upload.status === "FAILED" && upload.source === "BUILD" ? (
                  <Button
                    disabled={busy === upload.id}
                    onClick={() =>
                      void run(upload.id, RETRY_DSYM_UPLOAD_MUTATION)
                    }
                    size="sm"
                    variant="outline"
                  >
                    <RotateCw /> {t("retry")}
                  </Button>
                ) : null}
                {upload.status === "FAILED" || upload.status === "UPLOADING" ? (
                  <Button
                    aria-label={t("delete")}
                    disabled={busy === upload.id}
                    onClick={() =>
                      void run(upload.id, DELETE_DSYM_UPLOAD_MUTATION)
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function DsymsPage() {
  const t = useTranslations("crashes");
  const searchParams = useSearchParams();
  const [buildId, setBuildId] = useState<string | null>(
    searchParams.get("buildId"),
  );
  const [data, setData] = useState<DsymsData | null>(null);
  const [extra, setExtra] = useState<DsymSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [project, setProject] = useState<string>(ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filter = useMemo(
    () => ({
      search: search || null,
      projectName: project === ALL ? null : project,
      buildId,
    }),
    [buildId, project, search],
  );

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await controlPlaneRequest<DsymsData>(
          DSYMS_QUERY,
          { filter, first: PAGE_SIZE },
          { signal },
        );
        if (signal.aborted) return;
        setData(next);
        setExtra([]);
        setCursor(next.dsyms.nextCursor);
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
  useCrashLiveReload(["dsyms"], load);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await controlPlaneRequest<DsymsData>(DSYMS_QUERY, {
        filter,
        first: PAGE_SIZE,
        after: cursor,
      });
      setExtra((current) => [...current, ...next.dsyms.nodes]);
      setCursor(next.dsyms.nextCursor);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingMore(false);
    }
  }

  async function deleteSelected() {
    try {
      await controlPlaneRequest(DELETE_DSYMS_MUTATION, { ids: [...selected] });
      setSelected(new Set());
      setConfirmDelete(false);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  const dsyms = [...(data?.dsyms.nodes ?? []), ...extra];
  const filtered = Boolean(search) || project !== ALL || Boolean(buildId);

  return (
    <CrashesShell onChanged={() => void load()}>
      <PendingUploads onChanged={load} uploads={data?.dsymUploads ?? []} />
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:max-w-sm md:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("searchDsyms")}
            className="pl-8"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t("searchDsyms")}
            value={searchInput}
          />
        </div>
        <Select onValueChange={setProject} value={project}>
          <SelectTrigger aria-label={t("projectName")} className="md:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allProjects")}</SelectItem>
            {data?.dsymProjects.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {buildId ? (
          <Badge className="gap-1" variant="secondary">
            {t("buildFilter", { build: buildId })}
            <button
              aria-label={t("clearBuildFilter")}
              onClick={() => setBuildId(null)}
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
            description={t("deleteDsymsDescription", { count: selected.size })}
            onConfirm={deleteSelected}
            onOpenChange={setConfirmDelete}
            open={confirmDelete}
            title={t("deleteDsymsTitle", { count: selected.size })}
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
      ) : dsyms.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileArchive />
            </EmptyMedia>
            <EmptyTitle>
              {filtered ? t("noMatchingDsyms") : t("noDsyms")}
            </EmptyTitle>
            <EmptyDescription>
              {filtered
                ? t("noMatchingDsymsDescription")
                : t("noDsymsDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <DsymTable
            dsyms={dsyms}
            onSelectedChange={setSelected}
            selected={selected}
          />
          <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
            <span>
              {t("showingCount", {
                shown: dsyms.length,
                total: data?.dsyms.matchingCount ?? dsyms.length,
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
