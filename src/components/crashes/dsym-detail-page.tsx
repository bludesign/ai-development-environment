"use client";

import { Download, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { DetailItem, DetailList } from "@/components/common/detail-list";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { useOwnedRead } from "@/hooks/use-owned-read";
import { useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CrashTable } from "./crashes-page";
import {
  DsymBuildLink,
  DsymSourceBadge,
  DsymTable,
  dsymVersion,
} from "./dsyms-page";
import {
  DELETE_DSYMS_MUTATION,
  DSYM_DETAIL_QUERY,
  UPDATE_DSYM_UPLOAD_MUTATION,
} from "./graphql";
import type { CrashSummary, DsymDetail, DsymUpload } from "./types";
import { formatBytes } from "./uploads";
import { useCrashLiveReload } from "./use-crash-live-reload";

function EditMetadataDialog({
  upload,
  open,
  onOpenChange,
  onSaved,
}: {
  upload: DsymUpload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations("crashes");
  const [projectName, setProjectName] = useState(upload.projectName ?? "");
  const [buildId, setBuildId] = useState(upload.buildId ?? "");
  const [url, setUrl] = useState(upload.url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await controlPlaneRequest(UPDATE_DSYM_UPLOAD_MUTATION, {
        id: upload.id,
        input: {
          projectName: projectName.trim() || null,
          buildId: buildId.trim() || null,
          url: url.trim() || null,
        },
      });
      onSaved();
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editMetadata")}</DialogTitle>
          <DialogDescription>
            {t("editMetadataDescription", { count: upload.dsymCount })}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="edit-project">{t("projectName")}</FieldLabel>
            <Input
              id="edit-project"
              onChange={(event) => setProjectName(event.target.value)}
              value={projectName}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-build">{t("buildId")}</FieldLabel>
            <Input
              disabled={upload.source === "BUILD"}
              id="edit-build"
              onChange={(event) => setBuildId(event.target.value)}
              value={buildId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-url">{t("url")}</FieldLabel>
            <Input
              id="edit-url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
              type="url"
              value={url}
            />
          </Field>
        </FieldGroup>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner /> : null}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DsymDetailPage({ dsymId }: { dsymId: string }) {
  const t = useTranslations("crashes");
  const locale = useLocale();
  const router = useRouter();
  const [dsym, setDsym] = useState<DsymDetail | null>(null);
  const [moreCrashes, setMoreCrashes] = useState<CrashSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await controlPlaneRequest<{ dsym: DsymDetail | null }>(
          DSYM_DETAIL_QUERY,
          { id: dsymId },
          { signal },
        );
        if (signal.aborted) return;
        setDsym(data.dsym);
        setMoreCrashes([]);
        setCursor(data.dsym?.crashes.nextCursor ?? null);
        setError(null);
      } catch (value) {
        if (!signal.aborted) {
          setError(value instanceof Error ? value.message : String(value));
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [dsymId],
  );
  const load = useOwnedRead(fetchData);
  useCrashLiveReload(["crashes", "dsyms"], load);

  async function loadMore() {
    if (!cursor) return;
    try {
      const data = await controlPlaneRequest<{ dsym: DsymDetail | null }>(
        DSYM_DETAIL_QUERY,
        { id: dsymId, after: cursor },
      );
      setMoreCrashes((current) => [
        ...current,
        ...(data.dsym?.crashes.nodes ?? []),
      ]);
      setCursor(data.dsym?.crashes.nextCursor ?? null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function remove() {
    try {
      await controlPlaneRequest(DELETE_DSYMS_MUTATION, { ids: [dsymId] });
      router.push("/crashes/dsyms");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (!dsym) {
    return (
      <Card className="mx-auto w-full max-w-[1600px]">
        <CardHeader>
          <CardTitle>{t("dsymNotFound")}</CardTitle>
          <CardDescription>
            {error ?? t("dsymNotFoundDescription")}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const crashes = [...dsym.crashes.nodes, ...moreCrashes];

  return (
    <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
      <div className="flex min-w-0 flex-col items-start gap-4 lg:flex-row lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {dsym.bundleName}
            </h1>
            <DsymSourceBadge source={dsym.upload.source} />
          </div>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {dsym.bundleIdentifier ?? dsym.binaryName}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(true)} variant="outline">
            <Pencil /> {t("editMetadata")}
          </Button>
          <Button asChild variant="outline">
            <a download href={dsym.downloadUrl}>
              <Download /> {t("downloadDsym")}
            </a>
          </Button>
          <ConfirmationDialog
            actionLabel={t("delete")}
            cancelLabel={t("cancel")}
            description={t("deleteDsymsDescription", { count: 1 })}
            onConfirm={remove}
            title={t("deleteDsymsTitle", { count: 1 })}
            trigger={
              <Button aria-label={t("delete")} size="icon" variant="ghost">
                <Trash2 />
              </Button>
            }
          />
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("details")}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailList className="sm:grid-cols-2 lg:grid-cols-4">
            <DetailItem label={t("binary")}>{dsym.binaryName}</DetailItem>
            <DetailItem label={t("version")}>{dsymVersion(dsym)}</DetailItem>
            <DetailItem label={t("projectName")}>
              {dsym.upload.projectName ?? "—"}
            </DetailItem>
            <DetailItem label={t("buildId")}>
              <DsymBuildLink upload={dsym.upload} />
            </DetailItem>
            <DetailItem className="lg:col-span-2" label={t("url")}>
              {dsym.upload.url ? (
                <a
                  className="inline-flex items-center gap-1 underline [overflow-wrap:anywhere]"
                  href={dsym.upload.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {dsym.upload.url} <ExternalLink className="size-3" />
                </a>
              ) : (
                "—"
              )}
            </DetailItem>
            <DetailItem label={t("uploadedBy")}>
              {dsym.upload.uploadedBy ?? t(`sources.${dsym.upload.source}`)}
            </DetailItem>
            <DetailItem label={t("uploaded")}>
              <DateTime value={dsym.createdAt} />
            </DetailItem>
            <DetailItem label={t("size")}>
              {formatBytes(dsym.dwarfSizeBytes, locale)}
            </DetailItem>
            <DetailItem label={t("uploadFile")}>
              {dsym.upload.filename}
            </DetailItem>
            <DetailItem className="lg:col-span-2" label={t("sha256")} mono>
              {dsym.dwarfSha256}
            </DetailItem>
          </DetailList>
        </CardContent>
      </Card>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="py-4">
          <CardTitle>{t("slices")}</CardTitle>
          <CardDescription>{t("slicesDescription")}</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("uuid")}</TableHead>
              <TableHead>{t("architecture")}</TableHead>
              <TableHead>{t("textAddress")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dsym.slices.map((slice) => (
              <TableRow key={slice.id}>
                <TableCell className="font-mono text-xs">
                  {slice.uuid}
                </TableCell>
                <TableCell>{slice.arch}</TableCell>
                <TableCell className="font-mono text-xs">
                  {slice.textVmAddr}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">
          {t("attachedCrashes", { count: dsym.crashes.totalCount })}
        </h2>
        {crashes.length ? (
          <Card className="gap-0 overflow-hidden py-0">
            <CrashTable crashes={crashes} />
            {cursor ? (
              <div className="flex justify-end border-t px-4 py-3">
                <Button
                  onClick={() => void loadMore()}
                  size="sm"
                  variant="outline"
                >
                  {t("loadMore")}
                </Button>
              </div>
            ) : null}
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("noAttachedCrashes")}
          </p>
        )}
      </div>
      {dsym.siblingDsyms.length ? (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">{t("sameUpload")}</h2>
          <Card className="gap-0 overflow-hidden py-0">
            <DsymTable dsyms={dsym.siblingDsyms} />
          </Card>
        </div>
      ) : null}
      <EditMetadataDialog
        key={`${dsym.upload.id}-${dsym.upload.updatedAt}`}
        onOpenChange={setEditing}
        onSaved={() => void load()}
        open={editing}
        upload={dsym.upload}
      />
    </section>
  );
}
