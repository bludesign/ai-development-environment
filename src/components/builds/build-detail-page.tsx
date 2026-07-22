"use client";

import {
  Archive,
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  Copy,
  Download,
  FileJson,
  ChartNoAxesColumn,
  ChevronDown,
  ChevronRight,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, useRouter } from "@/i18n/navigation";
import { copyText, createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import type { PublicOrigin } from "@/lib/public-origin";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";

import { buildStatusVariant } from "./build-format";
import { ExportArchiveDialog } from "./export-archive-dialog";
import { IosInstallButton } from "./ios-install-button";
import { RebuildButton } from "./rebuild-button";
import { RunBuildControls } from "./run-build-controls";
import type { BuildLogEvent, BuildRecord, BuildReport } from "./types";

const BUILD_DETAIL_FIELDS = `
  id requestId jobId status action destinationType destination snapshot commandSummary artifactDirectory errorCode error outOfDate
  createdAt startedAt finishedAt durationMs updatedAt
  worktree { id highlightColor }
  configuration {
  id name iconKey scheme buildConfiguration defaultAction advancedSettings autoExport exportSettings createdAt updatedAt
    source { id kind relativePath }
  }
  artifacts { id kind relativePath sizeBytes checksum metadata createdAt }
  reports {
    id kind source status summary data error createdAt updatedAt finishedAt
    artifact { id kind relativePath sizeBytes checksum metadata createdAt }
  }
  scriptExecutions { id phase position nameSnapshot status exitCode durationMs causedBuildFailure outputRelativePath error }
  deployments { id batchId destination status commandSummary outputRelativePath error createdAt startedAt finishedAt }
  exports { id status settings commandSummary outputRelativePath error createdAt startedAt finishedAt }
`;

const LOG_FIELDS = `id scope scopeId sequence phase level stream message createdAt`;

/** Acronyms that title casing would otherwise mangle, such as IPA into "Ipa". */
const PRESERVED_ACRONYMS = new Set(["IPA"]);

function humanizeConstant(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) =>
      PRESERVED_ACRONYMS.has(part)
        ? part
        : `${part.charAt(0).toLocaleUpperCase()}${part.slice(1).toLocaleLowerCase()}`,
    )
    .join(" ");
}

function humanizeIdentifier(value: string): string {
  return humanizeConstant(
    value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_"),
  );
}

const ADVANCED_SETTING_ORDER = [
  "packageResolution",
  "disablePackageRepositoryCache",
  "signingStyle",
  "developmentTeam",
  "codeSignIdentity",
  "provisioningProfileSpecifier",
  "productBundleIdentifier",
  "allowProvisioningUpdates",
  "allowProvisioningDeviceRegistration",
  "testPlan",
  "codeCoverage",
  "parseTestResults",
  "parallelTesting",
  "parallelTestingWorkers",
  "onlyTesting",
  "skipTesting",
  "buildSettingOverrides",
  "priorBuildForTestingId",
  "priorTestProductsPath",
  "priorXctestrunPath",
] as const;

const ADVANCED_SETTING_DEFAULTS: Record<string, unknown> = {
  packageResolution: "DEFAULT",
  disablePackageRepositoryCache: false,
  signingStyle: "PROJECT_DEFAULT",
  developmentTeam: null,
  codeSignIdentity: null,
  provisioningProfileSpecifier: null,
  productBundleIdentifier: null,
  allowProvisioningUpdates: false,
  allowProvisioningDeviceRegistration: false,
  testPlan: null,
  codeCoverage: false,
  parseTestResults: true,
  parallelTesting: null,
  parallelTestingWorkers: null,
  onlyTesting: [],
  skipTesting: [],
  buildSettingOverrides: {},
  priorBuildForTestingId: null,
  priorTestProductsPath: null,
  priorXctestrunPath: null,
};

function advancedSettingHasValue(key: string, value: unknown) {
  if (Object.hasOwn(ADVANCED_SETTING_DEFAULTS, key)) {
    return (
      JSON.stringify(value) !== JSON.stringify(ADVANCED_SETTING_DEFAULTS[key])
    );
  }
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === false
  ) {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function BuildDetailPage({
  buildId,
  publicOrigin,
}: {
  buildId: string;
  publicOrigin: PublicOrigin | null;
}) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const router = useRouter();
  const [build, setBuild] = useState<BuildRecord | null>(null);
  const [logs, setLogs] = useState<BuildLogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reportBusy, setReportBusy] = useState<
    "TEST_RESULTS" | "CODE_COVERAGE" | null
  >(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [logsOpen, setLogsOpen] = useState(true);
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
  const testReport = build?.reports?.find(
    (report) => report.kind === "TEST_RESULTS",
  );
  const coverageReport = build?.reports?.find(
    (report) => report.kind === "CODE_COVERAGE",
  );
  const resultBundle = build?.artifacts.find(
    (artifact) => artifact.kind === "RESULT_BUNDLE",
  );
  const testAction = build
    ? ["TEST", "TEST_WITHOUT_BUILDING"].includes(build.action)
    : false;
  const snapshot = build?.snapshot ?? {};
  const repository = snapshot.repository as { name?: string } | undefined;
  const worktree = snapshot.worktree as
    | { branch?: string | null; folder?: string; headSha?: string | null }
    | undefined;
  const configuration = snapshot.configuration as
    | {
        name?: string;
        scheme?: string;
        buildConfiguration?: string;
        advancedSettings?: Record<string, unknown>;
      }
    | undefined;
  const coverageAvailable =
    resultBundle?.metadata.coverageAvailable === true ||
    configuration?.advancedSettings?.codeCoverage === true;
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : "—";
  const highlightColor = build?.worktree?.highlightColor;

  const copyCommandSummary = async (commandSummary: string) => {
    try {
      await copyText(commandSummary);
      setCommandCopied(true);
    } catch {
      setError(t("copyFailed"));
    }
  };

  const generateReport = async (kind: "TEST_RESULTS" | "CODE_COVERAGE") => {
    setReportBusy(kind);
    setError(null);
    try {
      const field =
        kind === "TEST_RESULTS"
          ? "parseBuildTestResults"
          : "generateBuildCoverageReport";
      await controlPlaneRequest(
        `mutation GenerateBuildReport($buildId: ID!, $requestId: ID!) {
          ${field}(buildId: $buildId, requestId: $requestId) { id status error }
        }`,
        { buildId, requestId: createClientId() },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setReportBusy(null);
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
      <p className="mx-auto flex w-full max-w-[1500px] items-center gap-2 text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }
  if (!build) {
    return (
      <Empty className="mx-auto w-full max-w-[1500px] border py-12">
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
    <section className="mx-auto flex min-w-0 w-full max-w-[1500px] flex-col gap-5">
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
      <div
        data-testid="build-summary"
        className={cn(
          "flex flex-wrap items-start justify-between gap-4",
          highlightColor && "rounded-lg border-l-4 px-4 py-3",
          highlightColor && worktreeHighlightBackgroundClasses[highlightColor],
          highlightColor && worktreeHighlightAccentClasses[highlightColor],
        )}
      >
        <div>
          <p className="text-sm text-muted-foreground">
            {repository?.name ?? "—"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">
              {configuration?.name ?? build.id}
            </h1>
            <Badge variant={buildStatusVariant(build.status)}>
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
          {!activeOperation &&
            testAction &&
            resultBundle &&
            testReport?.status !== "READY" && (
              <Button
                disabled={reportBusy !== null}
                onClick={() => void generateReport("TEST_RESULTS")}
                variant="outline"
              >
                {reportBusy === "TEST_RESULTS" ? <Spinner /> : <FileJson />}
                {testReport?.status === "FAILED"
                  ? t("retryParseTestResults")
                  : t("parseTestResultsAction")}
              </Button>
            )}
          {!activeOperation &&
            resultBundle &&
            coverageAvailable &&
            coverageReport?.status !== "READY" && (
              <Button
                disabled={reportBusy !== null}
                onClick={() => void generateReport("CODE_COVERAGE")}
                variant="outline"
              >
                {reportBusy === "CODE_COVERAGE" ? (
                  <Spinner />
                ) : (
                  <ChartNoAxesColumn />
                )}
                {coverageReport?.status === "FAILED"
                  ? t("retryCoverageReport")
                  : t("generateCoverageReport")}
              </Button>
            )}
          {coverageReport?.status === "READY" && (
            <Button asChild variant="outline">
              <Link href={`/builds/${build.id}/coverage`}>
                <ChartNoAxesColumn /> {t("viewCoverageReport")}
              </Link>
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

      {testReport && <TestResultsCard report={testReport} />}

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="min-w-0 space-y-5">
          <Card className="gap-0 py-0">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <Button
                  aria-expanded={logsOpen}
                  className="-m-2 h-auto min-w-0 flex-1 justify-start p-2 text-left aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:bg-transparent dark:aria-expanded:hover:bg-muted/50"
                  onClick={() => setLogsOpen((current) => !current)}
                  type="button"
                  variant="ghost"
                >
                  <span className="truncate font-medium">{t("logs")}</span>
                </Button>
                <div className="ml-auto flex items-center gap-1">
                  {logsOpen && (
                    <>
                      <Button
                        aria-label={t("scrollLogsToTop")}
                        onClick={() => scrollLogs("top")}
                        size="icon-xs"
                        type="button"
                        variant="outline"
                      >
                        <ArrowUpToLine />
                      </Button>
                      <Button
                        aria-label={t("scrollLogsToBottom")}
                        onClick={() => scrollLogs("bottom")}
                        size="icon-xs"
                        type="button"
                        variant="outline"
                      >
                        <ArrowDownToLine />
                      </Button>
                    </>
                  )}
                  <Button
                    aria-expanded={logsOpen}
                    aria-label={t(logsOpen ? "collapseLogs" : "expandLogs")}
                    onClick={() => setLogsOpen((current) => !current)}
                    size="icon-sm"
                    title={t(logsOpen ? "collapseLogs" : "expandLogs")}
                    type="button"
                    variant="ghost"
                  >
                    {logsOpen ? (
                      <ChevronDown className="size-5" />
                    ) : (
                      <ChevronRight className="size-5" />
                    )}
                  </Button>
                </div>
              </div>
            </CardHeader>
            {logsOpen && (
              <CardContent className="py-4">
                <pre
                  className="max-h-[calc(100svh-8rem)] w-full min-w-0 max-w-full overflow-auto rounded-lg bg-neutral-950 p-3 text-xs whitespace-pre-wrap text-neutral-100 [overflow-wrap:anywhere] sm:max-h-[48rem]"
                  ref={logRef}
                >
                  {logs.length
                    ? logs
                        .map((log) => `[${log.phase}] ${log.message}`)
                        .join("\n")
                    : t("noLogs")}
                </pre>
              </CardContent>
            )}
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
              <pre className="w-full min-w-0 max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
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
                        {execution.nameSnapshot} ·{" "}
                        {humanizeConstant(execution.phase)}
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
                      {humanizeConstant(execution.status)}
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
        <div className="min-w-0 space-y-5">
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
          <AdvancedSettingsCard settings={configuration?.advancedSettings} />
          <Card>
            <CardHeader>
              <CardTitle>{t("artifacts")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {build.artifacts.length ? (
                build.artifacts.map((artifact) => {
                  const ipa = artifact.kind === "IPA";
                  const metadata = (artifact.metadata ?? {}) as Record<
                    string,
                    unknown
                  >;
                  return (
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
                            <Download />{" "}
                            {ipa ? t("downloadIpa") : t("downloadArtifact")}
                          </a>
                        </Button>
                      </div>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {artifact.relativePath}
                      </p>
                      {ipa && (
                        <>
                          <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                            {typeof metadata.bundleIdentifier === "string" && (
                              <div className="flex justify-between gap-2">
                                <dt>{t("ipaBundleIdentifier")}</dt>
                                <dd className="break-all font-mono">
                                  {metadata.bundleIdentifier}
                                </dd>
                              </div>
                            )}
                            {typeof metadata.bundleShortVersion ===
                              "string" && (
                              <div className="flex justify-between gap-2">
                                <dt>{t("ipaBundleVersion")}</dt>
                                <dd className="font-mono">
                                  {metadata.bundleShortVersion}
                                </dd>
                              </div>
                            )}
                          </dl>
                          <div className="mt-2 flex justify-end">
                            <IosInstallButton
                              artifactId={artifact.id}
                              buildId={build.id}
                              metadata={metadata}
                              publicOrigin={publicOrigin}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
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

function AdvancedSettingsCard({
  settings,
}: {
  settings: Record<string, unknown> | undefined;
}) {
  const t = useTranslations("builds");
  const labels: Record<string, string> = {
    packageResolution: t("packageResolution"),
    disablePackageRepositoryCache: t("disablePackageRepositoryCache"),
    signingStyle: t("signingStyle"),
    developmentTeam: t("developmentTeam"),
    codeSignIdentity: t("codeSignIdentity"),
    provisioningProfileSpecifier: t("provisioningProfileSpecifier"),
    productBundleIdentifier: t("productBundleIdentifier"),
    allowProvisioningUpdates: t("allowProvisioningUpdates"),
    allowProvisioningDeviceRegistration: t(
      "allowProvisioningDeviceRegistration",
    ),
    testPlan: t("testPlan"),
    codeCoverage: t("codeCoverage"),
    parseTestResults: t("parseTestResults"),
    parallelTesting: t("parallelTesting"),
    parallelTestingWorkers: t("parallelTestingWorkers"),
    onlyTesting: t("onlyTesting"),
    skipTesting: t("skipTesting"),
    buildSettingOverrides: t("buildSettingOverrides"),
    priorBuildForTestingId: t("priorBuildForTesting"),
    priorTestProductsPath: t("priorTestProductsPath"),
    priorXctestrunPath: t("priorXctestrunPath"),
  };
  const known = new Set<string>(ADVANCED_SETTING_ORDER);
  const keys = settings
    ? [
        ...ADVANCED_SETTING_ORDER.filter((key) => Object.hasOwn(settings, key)),
        ...Object.keys(settings)
          .filter((key) => !known.has(key))
          .sort(),
      ].filter((key) => advancedSettingHasValue(key, settings[key]))
    : [];
  if (!settings || !keys.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("advancedSettings")}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          {keys.map((key) => (
            <div key={key}>
              <dt className="text-xs text-muted-foreground">
                {labels[key] ?? humanizeIdentifier(key)}
              </dt>
              <dd className="mt-0.5 min-w-0">
                <AdvancedSettingValue value={settings[key]} />
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function AdvancedSettingValue({ value }: { value: unknown }) {
  const t = useTranslations("builds");
  if (typeof value === "boolean") {
    return (
      <Badge variant={value ? "default" : "secondary"}>
        {t(value ? "settingsEnabled" : "settingsDisabled")}
      </Badge>
    );
  }
  if (value === null || value === undefined || value === "") return <>—</>;
  if (Array.isArray(value)) {
    return value.length ? (
      <span className="break-words font-mono text-xs">
        {value.map(String).join(", ")}
      </span>
    ) : (
      <>—</>
    );
  }
  if (typeof value === "object") {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? (
      <span className="break-all font-mono text-xs">{serialized}</span>
    ) : (
      <>—</>
    );
  }
  if (typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value)) {
    return <>{humanizeConstant(value)}</>;
  }
  return <span className="break-words font-mono text-xs">{String(value)}</span>;
}

type TestCaseResult = {
  identifier?: unknown;
  name?: unknown;
  plan?: unknown;
  configuration?: unknown;
  bundle?: unknown;
  suite?: unknown;
  file?: unknown;
  filePath?: unknown;
  result?: unknown;
  durationSeconds?: unknown;
  tags?: unknown;
  details?: unknown;
};

type TestResultFilter = "ALL" | "PASSED" | "FAILED" | "SKIPPED";

type TestSuiteGroup = {
  key: string;
  name: string | null;
  bundle: string | null;
  plan: string | null;
  configuration: string | null;
  tests: TestCaseResult[];
};

function optionalTestString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function matchesTestFilter(
  test: TestCaseResult,
  filter: TestResultFilter,
): boolean {
  if (filter === "ALL") return true;
  return String(test.result ?? "unknown").toLocaleUpperCase() === filter;
}

function groupTestSuites(tests: TestCaseResult[]): TestSuiteGroup[] {
  const groups = new Map<string, TestSuiteGroup>();
  for (const test of tests) {
    const bundle = optionalTestString(test.bundle);
    const suite = optionalTestString(test.suite);
    const plan = optionalTestString(test.plan);
    const configuration = optionalTestString(test.configuration);
    const name = suite ?? bundle;
    const key = JSON.stringify([plan, configuration, bundle, name]);
    const group = groups.get(key) ?? {
      key,
      name,
      bundle,
      plan,
      configuration,
      tests: [],
    };
    group.tests.push(test);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    (left.name ?? "").localeCompare(right.name ?? "", undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function testFileName(test: TestCaseResult): string | null {
  const explicit = optionalTestString(test.file);
  if (explicit) return explicit;
  const suite = optionalTestString(test.suite);
  if (suite) return suite;
  return optionalTestString(test.identifier)?.split("/")[0] ?? null;
}

function TestResultsCard({ report }: { report: BuildReport }) {
  const t = useTranslations("builds");
  const [filter, setFilter] = useState<TestResultFilter>("ALL");
  const tests = Array.isArray(report.data.tests)
    ? (report.data.tests as TestCaseResult[])
    : [];
  const devices = Array.isArray(report.data.devices)
    ? (report.data.devices as Array<Record<string, unknown>>)
    : [];
  const number = (key: string) =>
    typeof report.summary[key] === "number" ? Number(report.summary[key]) : 0;
  const suites = groupTestSuites(tests).filter((suite) =>
    suite.tests.some((test) => matchesTestFilter(test, filter)),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("testResults")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {report.status === "FAILED" ? (
          <Alert variant="destructive">
            <AlertDescription>
              {report.error ?? t("testResultsFailed")}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">
                {t("testTotal", { count: number("total") })}
              </Badge>
              <Badge className="bg-emerald-600 text-white dark:bg-emerald-700">
                {t("testPassed", { count: number("passed") })}
              </Badge>
              <Badge variant={number("failed") ? "destructive" : "outline"}>
                {t("testFailed", { count: number("failed") })}
              </Badge>
              <Badge
                className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                variant="outline"
              >
                {t("testSkipped", { count: number("skipped") })}
              </Badge>
              {devices.map((device, index) => (
                <Badge key={index} variant="outline">
                  {String(device.deviceName ?? device.modelName ?? "Device")} ·{" "}
                  {String(device.osVersion ?? "—")}
                </Badge>
              ))}
            </div>
            <div className="overflow-x-auto pb-1">
              <Tabs
                onValueChange={(value) => setFilter(value as TestResultFilter)}
                value={filter}
              >
                <TabsList aria-label={t("testResultFilters")}>
                  <TabsTrigger value="ALL">
                    {t("testFilterAll", { count: tests.length })}
                  </TabsTrigger>
                  <TabsTrigger value="PASSED">
                    {t("testFilterPassed", { count: number("passed") })}
                  </TabsTrigger>
                  <TabsTrigger value="FAILED">
                    {t("testFilterFailed", { count: number("failed") })}
                  </TabsTrigger>
                  <TabsTrigger value="SKIPPED">
                    {t("testFilterSkipped", { count: number("skipped") })}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="divide-y rounded-md border">
              {suites.map((suite) => (
                <TestSuiteResultGroup
                  filter={filter}
                  group={suite}
                  key={suite.key}
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TestSuiteResultGroup({
  filter,
  group,
}: {
  filter: TestResultFilter;
  group: TestSuiteGroup;
}) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const suiteName = group.name ?? t("testsWithoutSuite");
  const passed = group.tests.filter((test) => test.result === "Passed").length;
  const passRate = group.tests.length ? passed / group.tests.length : 0;
  const formattedRate = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(passRate);
  const filteredTests = group.tests.filter((test) =>
    matchesTestFilter(test, filter),
  );
  const fileGroups = new Map<string, TestCaseResult[]>();
  for (const test of filteredTests) {
    const file = testFileName(test) ?? t("testsWithoutFile");
    fileGroups.set(file, [...(fileGroups.get(file) ?? []), test]);
  }
  const metadata = [group.bundle, group.configuration, group.plan]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <button
        aria-expanded={open}
        aria-label={t(open ? "collapseTestSuite" : "expandTestSuite", {
          suite: suiteName,
        })}
        className="flex min-h-8 w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {suiteName}
        </span>
        {metadata && (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {metadata}
          </span>
        )}
        <Badge
          className={
            passRate === 1
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : passRate >= 0.5
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : ""
          }
          variant={passRate < 0.5 ? "destructive" : "outline"}
        >
          {t("testSuitePassed", {
            passed,
            total: group.tests.length,
            percent: formattedRate,
          })}
        </Badge>
      </button>
      {open && (
        <div className="border-t bg-muted/10 p-2">
          <div className="divide-y rounded-md border bg-background">
            {[...fileGroups.entries()]
              .sort(([left], [right]) =>
                left.localeCompare(right, locale, {
                  numeric: true,
                  sensitivity: "base",
                }),
              )
              .map(([file, fileTests]) => (
                <TestFileResultGroup file={file} key={file} tests={fileTests} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TestFileResultGroup({
  file,
  tests,
}: {
  file: string;
  tests: TestCaseResult[];
}) {
  const t = useTranslations("builds");
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        aria-expanded={open}
        aria-label={t(open ? "collapseTestFile" : "expandTestFile", { file })}
        className="flex min-h-8 w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={file}
        >
          {file}
        </span>
        <Badge variant="outline">
          {t("testTotal", { count: tests.length })}
        </Badge>
      </button>
      {open && (
        <div className="border-t overflow-auto">
          <Table aria-label={file} className="min-w-[38rem] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 px-2">{t("testStatus")}</TableHead>
                <TableHead className="h-8 px-2">{t("testName")}</TableHead>
                <TableHead className="h-8 px-2 text-right">
                  {t("testDuration")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tests.map((test, index) => {
                const details = Array.isArray(test.details)
                  ? test.details.filter(
                      (value): value is string => typeof value === "string",
                    )
                  : [];
                const tags = Array.isArray(test.tags)
                  ? test.tags.filter(
                      (value): value is string => typeof value === "string",
                    )
                  : [];
                const name = String(test.name ?? "—");
                const identifier = optionalTestString(test.identifier);
                return (
                  <TableRow key={`${identifier ?? name}:${index}`}>
                    <TableCell className="px-2 py-1.5">
                      <TestResultBadge
                        result={String(test.result ?? "unknown")}
                      />
                    </TableCell>
                    <TableCell className="max-w-xl px-2 py-1.5 whitespace-normal">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-medium">{name}</span>
                        {tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                      {identifier && identifier !== name && (
                        <p
                          className="truncate font-mono text-muted-foreground"
                          title={identifier}
                        >
                          {identifier}
                        </p>
                      )}
                      {details.map((detail, detailIndex) => (
                        <p className="mt-1 text-destructive" key={detailIndex}>
                          {detail}
                        </p>
                      ))}
                    </TableCell>
                    <TableCell className="px-2 py-1.5 text-right tabular-nums">
                      {typeof test.durationSeconds === "number"
                        ? `${test.durationSeconds.toFixed(3)}s`
                        : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function TestResultBadge({ result }: { result: string }) {
  const normalized = result.toLocaleLowerCase();
  const className =
    normalized === "passed"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : normalized === "skipped"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : normalized === "expected failure"
          ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
          : "";
  return (
    <Badge
      className={className}
      variant={normalized === "failed" ? "destructive" : "outline"}
    >
      {result}
    </Badge>
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
