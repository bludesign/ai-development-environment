"use client";

import {
  ChevronRight,
  Download,
  FileArchive,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { DetailItem, DetailList } from "@/components/common/detail-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOwnedRead } from "@/hooks/use-owned-read";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CrashStatusBadge } from "./crash-status-badge";
import { CrashTable, crashVersion } from "./crashes-page";
import { DsymTable } from "./dsyms-page";
import { DsymUploadDialog } from "./dsym-upload-dialog";
import { FramesTable } from "./frames-table";
import {
  CRASH_DETAIL_QUERY,
  DELETE_CRASHES_MUTATION,
  SYMBOLICATE_CRASH_MUTATION,
} from "./graphql";
import type { CrashDetail, CrashThread } from "./types";
import { formatBytes } from "./uploads";
import { useCrashLiveReload } from "./use-crash-live-reload";

function ThreadCard({
  thread,
  defaultOpen,
}: {
  thread: CrashThread;
  defaultOpen: boolean;
}) {
  const t = useTranslations("crashes");
  const label = [
    t("threadNumber", { number: thread.index }),
    thread.name ?? thread.queue,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <details
      className="group overflow-hidden rounded-lg border"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 bg-muted/40 px-4 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
        <span className="min-w-0 truncate">{label}</span>
        {thread.crashed ? (
          <Badge variant="destructive">{t("crashedThread")}</Badge>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("frameCount", { count: thread.frames.length })}
        </span>
      </summary>
      <FramesTable frames={thread.frames} />
    </details>
  );
}

export function CrashDetailPage({ crashId }: { crashId: string }) {
  const t = useTranslations("crashes");
  const locale = useLocale();
  const router = useRouter();
  const [crash, setCrash] = useState<CrashDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await controlPlaneRequest<{
          crashReport: CrashDetail | null;
        }>(CRASH_DETAIL_QUERY, { id: crashId }, { signal });
        if (signal.aborted) return;
        setCrash(data.crashReport);
        setError(null);
      } catch (value) {
        if (!signal.aborted) {
          setError(value instanceof Error ? value.message : String(value));
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [crashId],
  );
  const load = useOwnedRead(fetchData);
  useCrashLiveReload(["crashes", "dsyms"], load);

  async function symbolicate() {
    setBusy(true);
    try {
      await controlPlaneRequest(SYMBOLICATE_CRASH_MUTATION, { id: crashId });
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await controlPlaneRequest(DELETE_CRASHES_MUTATION, { ids: [crashId] });
      router.push("/crashes");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (!crash) {
    return (
      <Card className="mx-auto w-full max-w-[1600px]">
        <CardHeader>
          <CardTitle>{t("crashNotFound")}</CardTitle>
          <CardDescription>
            {error ?? t("crashNotFoundDescription")}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const crashed =
    crash.threads.find((thread) => thread.crashed) ?? crash.threads[0];
  const otherThreads = crash.threads.filter((thread) => thread !== crashed);
  const settled = !["PENDING", "WAITING_FOR_AGENT", "SYMBOLICATING"].includes(
    crash.status,
  );

  return (
    <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
      <div className="flex min-w-0 flex-col items-start gap-4 lg:flex-row lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {crash.appName ?? crash.filename}
            </h1>
            <CrashStatusBadge status={crash.status} />
            <Badge variant="outline">{t(`formats.${crash.format}`)}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {crash.signatureTitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !settled}
            onClick={() => void symbolicate()}
            variant="outline"
          >
            {busy ? <Spinner /> : <RotateCw />} {t("resymbolicate")}
          </Button>
          <Button asChild variant="outline">
            <a download href={crash.symbolicatedDownloadUrl}>
              <Download /> {t("downloadSymbolicated")}
            </a>
          </Button>
          <Button asChild variant="outline">
            <a download href={crash.originalDownloadUrl}>
              <Download /> {t("downloadOriginal")}
            </a>
          </Button>
          <ConfirmationDialog
            actionLabel={t("delete")}
            cancelLabel={t("cancel")}
            description={t("deleteCrashesDescription", { count: 1 })}
            onConfirm={remove}
            title={t("deleteCrashesTitle", { count: 1 })}
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
      {crash.statusMessage && crash.status !== "SYMBOLICATED" ? (
        <Alert variant={crash.status === "FAILED" ? "destructive" : "default"}>
          <TriangleAlert />
          <AlertTitle>{t(`statuses.${crash.status}`)}</AlertTitle>
          <AlertDescription>{crash.statusMessage}</AlertDescription>
        </Alert>
      ) : null}
      {crash.missingImages.length ? (
        <Alert>
          <FileArchive />
          <AlertTitle>{t("missingDsymsTitle")}</AlertTitle>
          <AlertDescription>
            <p>{t("missingDsymsDescription")}</p>
            <ul className="mt-2 space-y-1">
              {crash.missingImages.map((image) => (
                <li className="font-mono text-xs" key={image.id}>
                  {image.name} · {image.uuid ?? "—"}
                  {image.arch ? ` (${image.arch})` : ""}
                </li>
              ))}
            </ul>
            <Button
              className="mt-3"
              onClick={() => setUploadOpen(true)}
              size="sm"
              variant="outline"
            >
              <FileArchive /> {t("uploadDsyms")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("summary")}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailList className="sm:grid-cols-2 lg:grid-cols-4">
            <DetailItem label={t("exception")}>
              {[crash.exceptionType, crash.signal && `(${crash.signal})`]
                .filter(Boolean)
                .join(" ") || "—"}
            </DetailItem>
            <DetailItem label={t("exceptionCodes")} mono>
              {crash.exceptionCodes ?? "—"}
            </DetailItem>
            <DetailItem label={t("terminationReason")}>
              {crash.terminationReason ?? "—"}
            </DetailItem>
            <DetailItem label={t("crashedThreadLabel")}>
              {crash.crashedThread ?? "—"}
            </DetailItem>
            {crash.exceptionSubtype ? (
              <DetailItem label={t("exceptionSubtype")}>
                {crash.exceptionSubtype}
              </DetailItem>
            ) : null}
            {crash.exceptionReason ? (
              <DetailItem
                className="lg:col-span-3"
                label={t("exceptionReason")}
              >
                {crash.exceptionReason}
              </DetailItem>
            ) : null}
            <DetailItem label={t("app")}>
              {crash.appName ?? "—"}
              {crash.bundleId ? (
                <span className="block font-mono text-xs text-muted-foreground">
                  {crash.bundleId}
                </span>
              ) : null}
            </DetailItem>
            <DetailItem label={t("version")}>{crashVersion(crash)}</DetailItem>
            <DetailItem label={t("device")}>
              {crash.deviceModel ?? "—"}
              {crash.arch ? (
                <span className="block text-xs text-muted-foreground">
                  {crash.arch}
                </span>
              ) : null}
            </DetailItem>
            <DetailItem label={t("osVersion")}>
              {crash.osVersion ?? "—"}
            </DetailItem>
            <DetailItem label={t("crashedAt")}>
              <DateTime value={crash.crashedAt} />
            </DetailItem>
            <DetailItem label={t("received")}>
              <DateTime value={crash.createdAt} />
            </DetailItem>
            <DetailItem label={t("symbolicatedAt")}>
              <DateTime value={crash.symbolicatedAt} />
            </DetailItem>
            <DetailItem label={t("incidentId")} mono>
              {crash.incidentId ?? "—"}
            </DetailItem>
            <DetailItem label={t("source")}>
              {t(`sources.${crash.source}`)}
              <span className="block text-xs text-muted-foreground">
                {crash.uploadedBy ??
                  (crash.apiKeyName
                    ? t("viaApiKey", { name: crash.apiKeyName })
                    : (crash.clientIp ?? ""))}
              </span>
            </DetailItem>
            <DetailItem label={t("file")}>
              {crash.filename}
              <span className="block text-xs text-muted-foreground">
                {formatBytes(crash.sizeBytes, locale)}
              </span>
            </DetailItem>
            <DetailItem className="lg:col-span-2" label={t("signature")} mono>
              <Link
                className="underline"
                href={`/crashes?signature=${encodeURIComponent(crash.signature)}`}
              >
                {crash.signature}
              </Link>
            </DetailItem>
          </DetailList>
          {crash.applicationSpecificInformation.length ? (
            <div className="mt-4">
              <p className="text-xs text-muted-foreground">
                {t("applicationSpecificInformation")}
              </p>
              <pre className="mt-1 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                {crash.applicationSpecificInformation.join("\n")}
              </pre>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="threads">
        <TabsList className="flex-wrap">
          <TabsTrigger value="threads">{t("threads")}</TabsTrigger>
          {crash.lastExceptionBacktrace?.length ? (
            <TabsTrigger value="exception">
              {t("exceptionBacktrace")}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="images">{t("binaryImages")}</TabsTrigger>
          <TabsTrigger value="dsyms">
            {t("attachedDsyms", { count: crash.attachedDsyms.length })}
          </TabsTrigger>
          <TabsTrigger value="similar">
            {t("similarCrashes", { count: crash.similarCrashCount })}
          </TabsTrigger>
          <TabsTrigger value="raw">{t("raw")}</TabsTrigger>
        </TabsList>
        <TabsContent className="space-y-3" value="threads">
          {crashed ? <ThreadCard defaultOpen thread={crashed} /> : null}
          {otherThreads.map((thread) => (
            <ThreadCard
              defaultOpen={false}
              key={thread.index}
              thread={thread}
            />
          ))}
        </TabsContent>
        {crash.lastExceptionBacktrace?.length ? (
          <TabsContent value="exception">
            <Card className="overflow-hidden py-0">
              <FramesTable frames={crash.lastExceptionBacktrace} />
            </Card>
          </TabsContent>
        ) : null}
        <TabsContent value="images">
          <Card className="gap-0 overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("binary")}</TableHead>
                  <TableHead>{t("uuid")}</TableHead>
                  <TableHead>{t("loadAddress")}</TableHead>
                  <TableHead>{t("dsym")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {crash.binaryImages.map((image) => (
                  <TableRow key={image.id}>
                    <TableCell className="max-w-72">
                      <span className={image.isApp ? "font-medium" : ""}>
                        {image.name}
                      </span>
                      {image.arch ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {image.arch}
                        </span>
                      ) : null}
                      {image.path ? (
                        <p
                          className="truncate font-mono text-xs text-muted-foreground"
                          title={image.path}
                        >
                          {image.path}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {image.uuid ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {image.loadAddress ?? "—"}
                    </TableCell>
                    <TableCell>
                      {image.dsym ? (
                        <Link
                          className="underline"
                          href={`/crashes/dsyms/${encodeURIComponent(image.dsym.id)}`}
                        >
                          {image.dsym.bundleName}
                        </Link>
                      ) : image.isApp && image.frameCount > 0 ? (
                        <Badge variant="outline">{t("dsymMissing")}</Badge>
                      ) : image.isApp ? (
                        <span className="text-xs text-muted-foreground">
                          {t("notNeeded")}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t("systemLibrary")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="dsyms">
          {crash.attachedDsyms.length ? (
            <Card className="gap-0 overflow-hidden py-0">
              <DsymTable dsyms={crash.attachedDsyms} />
            </Card>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("noAttachedDsyms")}
            </p>
          )}
        </TabsContent>
        <TabsContent value="similar">
          {crash.similarCrashes.length ? (
            <Card className="gap-0 overflow-hidden py-0">
              <CrashTable crashes={crash.similarCrashes} />
            </Card>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("noSimilarCrashes")}
            </p>
          )}
        </TabsContent>
        <TabsContent value="raw">
          <pre className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
            {crash.symbolicatedText}
          </pre>
        </TabsContent>
      </Tabs>
      <DsymUploadDialog
        onOpenChange={setUploadOpen}
        onUploaded={() => void load()}
        open={uploadOpen}
      />
    </section>
  );
}
