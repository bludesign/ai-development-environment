"use client";

import {
  Archive,
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  Copy,
  Download,
  Square,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Link, useRouter } from "@/i18n/navigation";
import { copyText, createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { RebuildButton } from "./rebuild-button";
import { RunBuildControls } from "./run-build-controls";
import type { BuildLogEvent, BuildRecord } from "./types";

const BUILD_DETAIL_FIELDS = `
  id requestId jobId status action destinationType destination snapshot commandSummary artifactDirectory errorCode error outOfDate
  createdAt startedAt finishedAt durationMs updatedAt
  configuration {
    id name iconKey scheme buildConfiguration defaultAction advancedSettings createdAt updatedAt
    source { id kind relativePath }
  }
  artifacts { id kind relativePath sizeBytes checksum metadata createdAt }
  scriptExecutions { id phase position nameSnapshot status exitCode durationMs causedBuildFailure outputRelativePath error }
  deployments { id batchId destination status commandSummary outputRelativePath error createdAt startedAt finishedAt }
  exports { id status settings commandSummary outputRelativePath error createdAt startedAt finishedAt }
`;

const LOG_FIELDS = `id scope scopeId sequence phase level stream message createdAt`;

function humanizeConstant(value: string): string {
  return value
    .toLocaleLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function BuildDetailPage({ buildId }: { buildId: string }) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const router = useRouter();
  const [build, setBuild] = useState<BuildRecord | null>(null);
  const [logs, setLogs] = useState<BuildLogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        build: BuildRecord | null;
        buildLogs: BuildLogEvent[];
      }>(
        `query BuildDetail($id: ID!) {
          build(id: $id) { ${BUILD_DETAIL_FIELDS} }
          buildLogs(buildId: $id, first: 5000) { ${LOG_FIELDS} }
        }`,
        { id: buildId },
      );
      setBuild(data.build);
      setLogs(data.buildLogs);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [buildId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const unsubscribeBuild = controlPlaneSubscriptions().subscribe<{
      buildChanged: { id: string };
    }>(
      {
        query: `subscription BuildChanged($id: ID!) { buildChanged(id: $id) { id } }`,
        variables: { id: buildId },
      },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const unsubscribeLogs = controlPlaneSubscriptions().subscribe<{
      buildLogAdded: BuildLogEvent;
    }>(
      {
        query: `subscription BuildLogAdded($buildId: ID!) {
          buildLogAdded(buildId: $buildId) { ${LOG_FIELDS} }
        }`,
        variables: { buildId },
      },
      {
        next: (value) => {
          const log = value.data?.buildLogAdded;
          if (!log) return;
          setLogs((current) =>
            current.some((entry) => entry.id === log.id)
              ? current
              : [...current, log],
          );
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      unsubscribeBuild();
      unsubscribeLogs();
    };
  }, [buildId, load]);

  const activeOperation =
    build !== null &&
    (["QUEUED", "PREPARING", "RUNNING"].includes(build.status) ||
      build.deployments.some((deployment) =>
        ["QUEUED", "RUNNING"].includes(deployment.status),
      ) ||
      build.exports.some((entry) =>
        ["QUEUED", "RUNNING"].includes(entry.status),
      ));
  useEffect(() => {
    if (!activeOperation) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [activeOperation, load]);

  useEffect(() => {
    if (!activeOperation || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [activeOperation, logs]);

  useEffect(() => {
    if (!commandCopied) return;
    const timer = window.setTimeout(() => setCommandCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [commandCopied]);

  const cancel = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation CancelBuild($id: ID!) { cancelBuild(id: $id) { id status } }`,
        { id: buildId },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const deleteBuild = async () => {
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation DeleteBuild($ids: [ID!]!) { deleteBuilds(ids: $ids) }`,
        { ids: [buildId] },
      );
      router.replace("/builds");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const runnable = build?.artifacts.some(
    (artifact) => artifact.kind === "RUNNABLE_APP",
  );
  const archive = build?.artifacts.some(
    (artifact) => artifact.kind === "ARCHIVE",
  );
  const snapshot = build?.snapshot ?? {};
  const repository = snapshot.repository as { name?: string } | undefined;
  const worktree = snapshot.worktree as
    | { branch?: string | null; folder?: string; headSha?: string | null }
    | undefined;
  const configuration = snapshot.configuration as
    { name?: string; scheme?: string; buildConfiguration?: string } | undefined;
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : "—";

  const copyCommandSummary = async (commandSummary: string) => {
    try {
      await copyText(commandSummary);
      setCommandCopied(true);
    } catch {
      setError(t("copyFailed"));
    }
  };

  const scrollLogs = (position: "top" | "bottom") => {
    const element = logRef.current;
    if (!element) return;
    element.scrollTo({
      behavior: "smooth",
      top: position === "top" ? 0 : element.scrollHeight,
    });
  };

  if (loading) {
    return (
      <p className="mx-auto flex max-w-6xl items-center gap-2 text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }
  if (!build) {
    return (
      <Empty className="mx-auto max-w-6xl border py-12">
        <EmptyHeader>
          <EmptyTitle>{t("buildNotFound")}</EmptyTitle>
          <EmptyDescription>{t("buildNotFoundDescription")}</EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href="/builds">
            <ArrowLeft /> {t("backToBuilds")}
          </Link>
        </Button>
      </Empty>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div>
        <Button asChild className="-ml-2" size="sm" variant="ghost">
          <Link href="/builds">
            <ArrowLeft /> {t("backToBuilds")}
          </Link>
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {build.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {build.errorCode ? `${build.errorCode}: ` : ""}
            {build.error}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {repository?.name ?? "—"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">
              {configuration?.name ?? build.id}
            </h1>
            <Badge
              variant={
                build.status === "FAILED"
                  ? "destructive"
                  : build.status === "SUCCEEDED"
                    ? "default"
                    : "secondary"
              }
            >
              {t(`statuses.${build.status}`)}
            </Badge>
            <Badge variant="outline">{t(`actions.${build.action}`)}</Badge>
            {build.outOfDate && (
              <Badge
                className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                variant="outline"
              >
                {t("outOfDate")}
              </Badge>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {worktree?.branch ?? worktree?.folder ?? "—"} ·{" "}
            {build.destination.name}
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {t("buildId")}: {build.id}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RebuildButton
            buildId={build.id}
            onCompleted={(rebuilt) => router.push(`/builds/${rebuilt.id}`)}
            onError={setError}
          />
          {["QUEUED", "PREPARING", "RUNNING"].includes(build.status) && (
            <Button
              disabled={busy}
              onClick={() => void cancel()}
              variant="destructive"
            >
              {busy ? <Spinner /> : <Square />} {t("cancelBuild")}
            </Button>
          )}
          {build.status === "SUCCEEDED" && runnable && (
            <RunBuildControls
              buildId={build.id}
              destinationType={build.destinationType}
              onCompleted={load}
              onError={setError}
              preferredDestination={build.destination}
            />
          )}
          {build.status === "SUCCEEDED" && archive && (
            <Button onClick={() => setExportOpen(true)} variant="outline">
              <Archive /> {t("exportArchive")}
            </Button>
          )}
          <Button
            disabled={
              busy || ["QUEUED", "PREPARING", "RUNNING"].includes(build.status)
            }
            onClick={() => setDeleteOpen(true)}
            variant="destructive"
          >
            <Trash2 /> {t("deleteBuild")}
          </Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>{t("logs")}</CardTitle>
              <CardAction className="flex gap-1">
                <Button
                  aria-label={t("scrollLogsToTop")}
                  onClick={() => scrollLogs("top")}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                >
                  <ArrowUpToLine />
                </Button>
                <Button
                  aria-label={t("scrollLogsToBottom")}
                  onClick={() => scrollLogs("bottom")}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                >
                  <ArrowDownToLine />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <pre
                className="max-h-[36rem] overflow-auto rounded-lg bg-neutral-950 p-3 text-xs whitespace-pre-wrap text-neutral-100"
                ref={logRef}
              >
                {logs.length
                  ? logs
                      .map((log) => `[${log.phase}] ${log.message}`)
                      .join("\n")
                  : t("noLogs")}
              </pre>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("commandSummary")}</CardTitle>
              <CardAction>
                <Button
                  aria-label={
                    commandCopied ? t("commandCopied") : t("copyCommand")
                  }
                  onClick={() => void copyCommandSummary(build.commandSummary)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  {commandCopied ? <Check /> : <Copy />}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                {build.commandSummary}
              </pre>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("scripts")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {build.scriptExecutions.length ? (
                build.scriptExecutions.map((execution) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2"
                    key={execution.id}
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {execution.nameSnapshot} · {execution.phase}
                      </p>
                      {execution.error && (
                        <p className="text-xs text-destructive">
                          {execution.error}
                        </p>
                      )}
                    </div>
                    <Badge
                      variant={
                        execution.status === "FAILED"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {execution.status}
                    </Badge>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noScriptExecutions")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>{t("overview")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                <Detail label={t("buildId")} value={build.id} mono />
                <Detail
                  label={t("scheme")}
                  value={configuration?.scheme ?? "—"}
                  mono
                />
                <Detail
                  label={t("configuration")}
                  value={configuration?.buildConfiguration ?? "—"}
                  mono
                />
                <Detail
                  label={t("head")}
                  value={worktree?.headSha ?? "—"}
                  mono
                />
                <Detail label={t("startedAt")} value={date(build.startedAt)} />
                <Detail
                  label={t("finishedAt")}
                  value={date(build.finishedAt)}
                />
                <Detail
                  label={t("artifactDirectory")}
                  value={build.artifactDirectory}
                  mono
                />
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("artifacts")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {build.artifacts.length ? (
                build.artifacts.map((artifact) => (
                  <div className="rounded-lg border p-2" key={artifact.id}>
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline">
                        {humanizeConstant(artifact.kind)}
                      </Badge>
                      <Button asChild size="sm" variant="outline">
                        <a
                          download
                          href={`/api/builds/${encodeURIComponent(build.id)}/artifacts/${encodeURIComponent(artifact.id)}`}
                        >
                          <Download /> {t("downloadArtifact")}
                        </a>
                      </Button>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {artifact.relativePath}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noArtifacts")}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("runsAndExports")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {build.deployments.map((deployment) => (
                <div className="rounded-lg border p-2" key={deployment.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">
                      {deployment.destination.name}
                    </p>
                    <div className="flex flex-col items-end gap-1">
                      <Badge
                        variant={
                          deployment.status === "FAILED"
                            ? "destructive"
                            : "outline"
                        }
                      >
                        {humanizeConstant(deployment.status)}
                      </Badge>
                      <time className="text-xs text-muted-foreground">
                        {date(
                          deployment.finishedAt ??
                            deployment.startedAt ??
                            deployment.createdAt,
                        )}
                      </time>
                    </div>
                  </div>
                  {deployment.error && (
                    <p className="mt-1 text-xs text-destructive">
                      {deployment.error}
                    </p>
                  )}
                </div>
              ))}
              {build.exports.map((entry) => (
                <div className="rounded-lg border p-2" key={entry.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{t("archiveExport")}</p>
                    <div className="flex flex-col items-end gap-1">
                      <Badge
                        variant={
                          entry.status === "FAILED" ? "destructive" : "outline"
                        }
                      >
                        {humanizeConstant(entry.status)}
                      </Badge>
                      <time className="text-xs text-muted-foreground">
                        {date(
                          entry.finishedAt ??
                            entry.startedAt ??
                            entry.createdAt,
                        )}
                      </time>
                    </div>
                  </div>
                  {entry.outputRelativePath && (
                    <p className="mt-1 font-mono text-xs">
                      {entry.outputRelativePath}
                    </p>
                  )}
                  {entry.error && (
                    <p className="mt-1 text-xs text-destructive">
                      {entry.error}
                    </p>
                  )}
                </div>
              ))}
              {!build.deployments.length && !build.exports.length && (
                <p className="text-sm text-muted-foreground">
                  {t("noRunsOrExports")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      {exportOpen && (
        <ExportArchiveDialog
          buildId={build.id}
          onOpenChange={setExportOpen}
          onSaved={load}
          open={exportOpen}
        />
      )}
      <ConfirmationDialog
        actionLabel={t("deleteBuild")}
        cancelLabel={t("cancel")}
        description={t("deleteBuildDescription")}
        onConfirm={deleteBuild}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("deleteBuildTitle")}
      />
    </section>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 break-all font-mono text-xs" : "mt-0.5"}>
        {value}
      </dd>
    </div>
  );
}

function ExportArchiveDialog({
  buildId,
  open,
  onOpenChange,
  onSaved,
}: {
  buildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("builds");
  const [method, setMethod] = useState("DEBUGGING");
  const [signingStyle, setSigningStyle] = useState("AUTOMATIC");
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation ExportArchive($input: ExportBuildArchiveInput!) {
          exportBuildArchive(input: $input) { id status }
        }`,
        {
          input: {
            buildId,
            requestId: createClientId(),
            settings: {
              method,
              signingStyle,
              teamId: teamId || null,
              signingCertificate: null,
              provisioningProfiles: {},
              uploadSymbols: true,
              manageAppVersionAndBuildNumber: true,
              testFlightInternalTestingOnly: false,
            },
          },
        },
      );
      await onSaved();
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("exportArchive")}</DialogTitle>
          <DialogDescription>{t("exportArchiveDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("distributionMethod")}</Label>
            <Select onValueChange={setMethod} value={method}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "DEBUGGING",
                  "RELEASE_TESTING",
                  "ENTERPRISE",
                  "APP_STORE_CONNECT",
                ].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("signingStyle")}</Label>
            <Select onValueChange={setSigningStyle} value={signingStyle}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTOMATIC">{t("automatic")}</SelectItem>
                <SelectItem value="MANUAL">{t("manual")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="export-team-id">{t("developmentTeam")}</Label>
            <Input
              id="export-team-id"
              onChange={(event) => setTeamId(event.target.value)}
              value={teamId}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy && <Spinner />} {t("exportArchive")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
