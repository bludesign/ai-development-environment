"use client";

import {
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_RECONCILE_EVENT_CAPABILITY,
} from "@ai-development-environment/agent-contract/codebases";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AgentDirectoryBrowser } from "@/components/agents/agent-directory-browser";
import { JobMonitor } from "@/components/agents/job-monitor";
import { StatusBadge } from "@/components/agents/status-badge";
import type { Agent, AgentJob } from "@/components/agents/types";
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
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import { copyText, createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import { AGENT_FIELDS, JOB_FIELDS } from "./graphql-fields";
import { samplePayloadForCapability } from "./capability-payloads";

type AgentCodebase = {
  id: string;
  folder: string;
  branch: string | null;
  headSha: string | null;
  syncState:
    | "IN_SYNC"
    | "AHEAD"
    | "BEHIND"
    | "DIVERGED"
    | "NO_UPSTREAM"
    | "DETACHED"
    | "UNKNOWN";
  availability:
    "AVAILABLE" | "MISSING" | "NOT_REPOSITORY" | "ORIGIN_MISMATCH" | "ERROR";
  lastCheckedAt: string | null;
  repository: {
    id: string;
    name: string;
    description: string;
    displayOrigin: string;
  };
};

type CodebaseOverviewRepository = AgentCodebase["repository"] & {
  codebases: Array<
    Omit<AgentCodebase, "repository"> & { agent: { id: string } }
  >;
};

const isActiveJob = (job: AgentJob) =>
  job.status === "QUEUED" || job.status === "RUNNING";

function upsertJob(jobs: AgentJob[], changed: AgentJob): AgentJob[] {
  const existing = jobs.some((job) => job.id === changed.id);
  return existing
    ? jobs.map((job) => (job.id === changed.id ? changed : job))
    : [changed, ...jobs];
}

export function AgentDetail({ agentId }: { agentId: string }) {
  const t = useTranslations("agentDetail");
  const locale = useLocale();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [codebases, setCodebases] = useState<AgentCodebase[]>([]);
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const loadId = ++latestLoad.current;
    try {
      const data = await controlPlaneRequest<{
        agent: Agent | null;
        agentJobs: AgentJob[];
        codebaseOverview: { repositories: CodebaseOverviewRepository[] };
      }>(
        `query AgentDetail($id: ID!) {
          agent(id: $id) { ${AGENT_FIELDS} }
          agentJobs(agentId: $id) { ${JOB_FIELDS} }
          codebaseOverview {
            repositories {
              id name description displayOrigin
              codebases {
                id folder branch headSha syncState availability lastCheckedAt
                agent { id }
              }
            }
          }
        }`,
        { id: agentId },
      );
      if (loadId !== latestLoad.current) return;
      setAgent(data.agent);
      setJobs(data.agentJobs);
      setCodebases(
        (data.codebaseOverview?.repositories ?? []).flatMap((repository) =>
          repository.codebases
            .filter((codebase) => codebase.agent.id === agentId)
            .map((codebase) => ({
              id: codebase.id,
              folder: codebase.folder,
              branch: codebase.branch,
              headSha: codebase.headSha,
              syncState: codebase.syncState,
              availability: codebase.availability,
              lastCheckedAt: codebase.lastCheckedAt,
              repository: {
                id: repository.id,
                name: repository.name,
                description: repository.description,
                displayOrigin: repository.displayOrigin,
              },
            })),
        ),
      );
      setSelectedJobId((current) =>
        current && data.agentJobs.some((job) => job.id === current)
          ? current
          : (data.agentJobs[0]?.id ?? null),
      );
      setLoadError(null);
    } catch (value) {
      if (loadId !== latestLoad.current) return;
      setLoadError(value instanceof Error ? value.message : String(value));
    } finally {
      if (loadId === latestLoad.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const client = controlPlaneSubscriptions();
    const unsubscribeAgent = client.subscribe<{ agentChanged: Agent }>(
      {
        query: `subscription AgentChanged($agentId: ID!) { agentChanged(agentId: $agentId) { ${AGENT_FIELDS} } }`,
        variables: { agentId },
      },
      {
        next: (value) =>
          value.data?.agentChanged && setAgent(value.data.agentChanged),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const unsubscribeCodebases = client.subscribe<{
      codebaseOverviewChanged: { codebaseId: string | null };
    }>(
      {
        query: `subscription CodebaseOverviewChanged {
          codebaseOverviewChanged { codebaseId repositoryId }
        }`,
      },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initialLoad);
      latestLoad.current += 1;
      unsubscribeAgent();
      unsubscribeCodebases();
    };
  }, [agentId, load]);

  const activeJobIds = useMemo(
    () => jobs.filter(isActiveJob).map((job) => job.id),
    [jobs],
  );

  useEffect(() => {
    const client = controlPlaneSubscriptions();
    const unsubscribers = activeJobIds.map((jobId) =>
      client.subscribe<{ agentJobChanged: AgentJob }>(
        {
          query: `subscription JobChanged($jobId: ID!) { agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} } }`,
          variables: { jobId },
        },
        {
          next: (value) => {
            const changed = value.data?.agentJobChanged;
            if (changed) setJobs((current) => upsertJob(current, changed));
          },
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [activeJobIds]);

  const saveBaseRepoDirectory = async (baseRepoDirectory: string | null) => {
    setDirectoryBusy(true);
    setDirectoryError(null);
    try {
      const data = await controlPlaneRequest<{
        updateAgentBaseRepoDirectory: Agent;
      }>(
        `mutation UpdateAgentBaseRepoDirectory($agentId: ID!, $baseRepoDirectory: String) {
          updateAgentBaseRepoDirectory(agentId: $agentId, baseRepoDirectory: $baseRepoDirectory) {
            ${AGENT_FIELDS}
          }
        }`,
        { agentId, baseRepoDirectory },
      );
      setAgent(data.updateAgentBaseRepoDirectory);
    } catch (value) {
      setDirectoryError(value instanceof Error ? value.message : String(value));
    } finally {
      setDirectoryBusy(false);
    }
  };

  const handleJobChanged = useCallback((changed: AgentJob, select = false) => {
    setJobs((current) => upsertJob(current, changed));
    if (select) setSelectedJobId(changed.id);
  }, []);

  if (loading)
    return (
      <p className="mx-auto flex max-w-6xl items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {t("loading")}
      </p>
    );
  if (loadError && !agent)
    return (
      <p className="mx-auto max-w-6xl text-sm text-destructive">{loadError}</p>
    );
  if (!agent)
    return (
      <p className="mx-auto max-w-6xl text-sm text-muted-foreground">
        {t("notFound")}
      </p>
    );

  const canBrowseDirectories =
    agent.connectionStatus === "ONLINE" &&
    agent.capabilities.includes(CODEBASE_BROWSE_JOB_KIND);
  const visibleCapabilities = agent.capabilities.filter((capability) =>
    capability
      .toLocaleLowerCase()
      .includes(capabilityQuery.toLocaleLowerCase()),
  );

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/agents">
            <ArrowLeft />
            {t("back")}
          </Link>
        </Button>
      </div>
      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <CardTitle className="text-2xl font-semibold tracking-tight">
                  {agent.name}
                </CardTitle>
                <StatusBadge status={agent.connectionStatus} />
              </div>
              <CardDescription className="mt-1">
                {agent.hostname} · {agent.osVersion} · {agent.architecture}
              </CardDescription>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              {agent.id}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <h2 className="font-medium">{t("generalInformation")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("generalInformationDescription")}
            </p>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Info label={t("version")} value={agent.version} />
            <Info
              label={t("cpuModel")}
              value={agent.cpuModel ?? t("unavailable")}
            />
            <Info label={t("operatingSystem")} value={agent.osVersion} />
            <Info label={t("architecture")} value={agent.architecture} />
            <Info
              label={t("lastSeen")}
              value={
                agent.lastSeenAt
                  ? new Date(agent.lastSeenAt).toLocaleString(locale)
                  : t("never")
              }
            />
            <Info
              label={t("ipAddress")}
              value={agent.ipAddress ?? t("unavailable")}
              mono
            />
          </dl>
          <div className="grid gap-3 md:grid-cols-2">
            <ResourceUsage
              free={agent.memoryFreeBytes}
              label={t("memory")}
              locale={locale}
              total={agent.memoryTotalBytes}
              unavailable={t("unavailable")}
              usedLabel={t("used")}
              freeLabel={t("free")}
            />
            <ResourceUsage
              free={agent.diskFreeBytes}
              label={t("disk")}
              locale={locale}
              total={agent.diskTotalBytes}
              unavailable={t("unavailable")}
              usedLabel={t("used")}
              freeLabel={t("free")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("capabilities")}</CardTitle>
          <CardDescription>{t("capabilitiesDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t("searchCapabilities")}
              className="pl-9"
              onChange={(event) => setCapabilityQuery(event.target.value)}
              placeholder={t("searchCapabilitiesPlaceholder")}
              type="search"
              value={capabilityQuery}
            />
          </div>
          {visibleCapabilities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noMatchingCapabilities")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>{t("capability")}</TableHead>
                  <TableHead>{t("kind")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleCapabilities.map((capability) => (
                  <CapabilityRow
                    agentId={agent.id}
                    capability={capability}
                    key={capability}
                    offline={agent.connectionStatus !== "ONLINE"}
                    onJobChanged={handleJobChanged}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AgentCodebasesCard codebases={codebases} locale={locale} />

      <Card>
        <CardHeader>
          <CardTitle>{t("baseRepoDirectory")}</CardTitle>
          <CardDescription>{t("baseRepoDirectoryDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg bg-muted p-3">
            <p className="text-xs text-muted-foreground">
              {t("currentDirectory")}
            </p>
            <p className="mt-1 break-all font-mono text-xs">
              {agent.baseRepoDirectory ?? t("notConfigured")}
            </p>
          </div>
          {directoryError && (
            <Alert className="mt-4" variant="destructive">
              <AlertDescription>{directoryError}</AlertDescription>
            </Alert>
          )}
          <div className="mt-4 flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              {canBrowseDirectories ? (
                <AgentDirectoryBrowser
                  agentId={agent.id}
                  disabled={directoryBusy}
                  key={`${agent.id}:${agent.baseRepoDirectory ?? ""}`}
                  onSelect={(path) => saveBaseRepoDirectory(path)}
                  selectLabel={t("useDirectory")}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("directoryBrowsingUnavailable")}
                </p>
              )}
            </div>
            {agent.baseRepoDirectory && (
              <Button
                disabled={directoryBusy}
                onClick={() => void saveBaseRepoDirectory(null)}
                type="button"
                variant="outline"
              >
                <Trash2 /> {t("clearDirectory")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <DerivedDataSettingsCard
        agent={agent}
        canBrowseDirectories={canBrowseDirectories}
        key={`${agent.id}:${agent.derivedDataLocationMode ?? "DEFAULT"}:${agent.derivedDataPath ?? ""}`}
        onSaved={setAgent}
      />

      {selectedJobId && (
        <JobMonitor key={selectedJobId} compact jobId={selectedJobId} />
      )}

      <section>
        <h2 className="mb-3 font-medium">{t("history")}</h2>
        {jobs.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>{t("noJobs")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("job")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("created")}</TableHead>
                  <TableHead>{t("finished")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow
                    aria-current={selectedJobId === job.id ? "true" : undefined}
                    aria-label={t("selectJob", { kind: job.kind })}
                    className={cn(
                      "cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      selectedJobId === job.id && "bg-muted/50",
                    )}
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedJobId(job.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      {job.kind}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={job.status} />
                    </TableCell>
                    <TableCell>
                      {new Date(job.createdAt).toLocaleString(locale)}
                    </TableCell>
                    <TableCell>
                      {job.finishedAt
                        ? new Date(job.finishedAt).toLocaleString(locale)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function DerivedDataSettingsCard({
  agent,
  canBrowseDirectories,
  onSaved,
}: {
  agent: Agent;
  canBrowseDirectories: boolean;
  onSaved: (agent: Agent) => void;
}) {
  const t = useTranslations("agentDetail");
  const [mode, setMode] = useState<"DEFAULT" | "ABSOLUTE" | "RELATIVE">(
    agent.derivedDataLocationMode ?? "DEFAULT",
  );
  const [path, setPath] = useState(agent.derivedDataPath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        updateAgentDerivedDataSettings: Agent;
      }>(
        `mutation UpdateAgentDerivedDataSettings($agentId: ID!, $input: UpdateAgentDerivedDataSettingsInput!) {
          updateAgentDerivedDataSettings(agentId: $agentId, input: $input) { ${AGENT_FIELDS} }
        }`,
        {
          agentId: agent.id,
          input: { mode, path: mode === "DEFAULT" ? null : path },
        },
      );
      onSaved(data.updateAgentDerivedDataSettings);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("derivedDataLocation")}</CardTitle>
        <CardDescription>{t("derivedDataLocationDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <div className="grid gap-2">
            <Label htmlFor="derived-data-mode">{t("derivedDataMode")}</Label>
            <Select
              disabled={busy}
              onValueChange={(value) =>
                setMode(value as "DEFAULT" | "ABSOLUTE" | "RELATIVE")
              }
              value={mode}
            >
              <SelectTrigger id="derived-data-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DEFAULT">
                  {t("derivedDataDefault")}
                </SelectItem>
                <SelectItem value="ABSOLUTE">
                  {t("derivedDataAbsolute")}
                </SelectItem>
                <SelectItem value="RELATIVE">
                  {t("derivedDataRelative")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === "DEFAULT" ? (
            <div className="rounded-lg bg-muted p-3 font-mono text-xs">
              ~/Library/Developer/Xcode/DerivedData
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="derived-data-path">
                {mode === "ABSOLUTE"
                  ? t("derivedDataAbsolutePath")
                  : t("derivedDataRelativePath")}
              </Label>
              <Input
                disabled={busy}
                id="derived-data-path"
                onChange={(event) => setPath(event.target.value)}
                placeholder={
                  mode === "ABSOLUTE"
                    ? "/Users/example/DerivedData"
                    : "DerivedData"
                }
                value={path}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  mode === "ABSOLUTE"
                    ? "derivedDataAbsoluteHelp"
                    : "derivedDataRelativeHelp",
                )}
              </p>
            </div>
          )}
          {mode === "ABSOLUTE" && canBrowseDirectories && (
            <AgentDirectoryBrowser
              agentId={agent.id}
              disabled={busy}
              onSelect={setPath}
              selectLabel={t("useDirectory")}
            />
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            disabled={busy || (mode !== "DEFAULT" && !path.trim())}
            type="submit"
          >
            {busy && <Spinner />}
            {t("saveDerivedDataSettings")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Info({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-xs")} title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatBytes(value: number, locale: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    value / 1024 ** unitIndex,
  )} ${units[unitIndex]}`;
}

function ResourceUsage({
  label,
  total,
  free,
  locale,
  unavailable,
  usedLabel,
  freeLabel,
}: {
  label: string;
  total?: number | null;
  free?: number | null;
  locale: string;
  unavailable: string;
  usedLabel: string;
  freeLabel: string;
}) {
  if (total == null || free == null || total <= 0) {
    return (
      <div className="rounded-lg border p-4">
        <p className="font-medium">{label}</p>
        <p className="mt-2 text-sm text-muted-foreground">{unavailable}</p>
      </div>
    );
  }
  const safeFree = Math.max(0, Math.min(free, total));
  const used = total - safeFree;
  const percentage = (used / total) * 100;
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {Math.round(percentage)}%
        </p>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          aria-label={`${label}: ${Math.round(percentage)}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(percentage)}
          className="h-full rounded-full bg-primary transition-[width]"
          role="progressbar"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">{usedLabel}</dt>
          <dd>{formatBytes(used, locale)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{freeLabel}</dt>
          <dd>{formatBytes(safeFree, locale)}</dd>
        </div>
      </dl>
    </div>
  );
}

function CapabilityRow({
  agentId,
  capability,
  offline,
  onJobChanged,
}: {
  agentId: string;
  capability: string;
  offline: boolean;
  onJobChanged: (job: AgentJob, select?: boolean) => void;
}) {
  const t = useTranslations("agentDetail");
  const [expanded, setExpanded] = useState(false);
  const eventCapability = capability === CODEBASE_RECONCILE_EVENT_CAPABILITY;
  const toggle = () => setExpanded((value) => !value);
  return (
    <Fragment>
      <TableRow
        aria-expanded={expanded}
        aria-label={
          expanded
            ? t("collapseCapability", { capability })
            : t("expandCapability", { capability })
        }
        className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <TableCell>
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </TableCell>
        <TableCell className="font-mono text-xs font-medium">
          {capability}
        </TableCell>
        <TableCell>
          <Badge variant="outline">
            {eventCapability ? t("event") : t("job")}
          </Badge>
        </TableCell>
      </TableRow>
      <TableRow
        className={expanded ? "bg-muted/20 hover:bg-muted/20" : "hidden"}
      >
        <TableCell className="whitespace-normal p-4" colSpan={3}>
          <CapabilityRunner
            agentId={agentId}
            capability={capability}
            eventCapability={eventCapability}
            offline={offline}
            onJobChanged={onJobChanged}
          />
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function CapabilityRunner({
  agentId,
  capability,
  eventCapability,
  offline,
  onJobChanged,
}: {
  agentId: string;
  capability: string;
  eventCapability: boolean;
  offline: boolean;
  onJobChanged: (job: AgentJob, select?: boolean) => void;
}) {
  const t = useTranslations("agentDetail");
  const toolsT = useTranslations("tools");
  const [payloadText, setPayloadText] = useState(() =>
    JSON.stringify(samplePayloadForCapability(capability), null, 2),
  );
  const [job, setJob] = useState<AgentJob | null>(null);
  const [eventResponse, setEventResponse] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!job || !isActiveJob(job)) return;
    return controlPlaneSubscriptions().subscribe<{ agentJobChanged: AgentJob }>(
      {
        query: `subscription CapabilityJobChanged($jobId: ID!) {
          agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} }
        }`,
        variables: { jobId: job.id },
      },
      {
        next: (value) => {
          const changed = value.data?.agentJobChanged;
          if (!changed) return;
          setJob(changed);
          onJobChanged(changed);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
  }, [job, onJobChanged]);

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      if (eventCapability) {
        const data = await controlPlaneRequest<{
          requestAgentCodebaseReconcile: boolean;
        }>(
          `mutation RequestAgentCodebaseReconcile($agentId: ID!) {
            requestAgentCodebaseReconcile(agentId: $agentId)
          }`,
          { agentId },
        );
        setEventResponse({ accepted: data.requestAgentCodebaseReconcile });
        setJob(null);
        return;
      }
      const payload: unknown = JSON.parse(payloadText);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(toolsT("invalidJsonObject"));
      }
      const data = await controlPlaneRequest<{ createAgentJob: AgentJob }>(
        `mutation InvokeAgentCapability($input: CreateAgentJobInput!) {
          createAgentJob(input: $input) { ${JOB_FIELDS} }
        }`,
        {
          input: {
            agentId,
            kind: capability,
            payload,
            idempotencyKey: `manual:${capability}:${createClientId()}`,
            timeoutSeconds: 86400,
          },
        },
      );
      setJob(data.createAgentJob);
      setEventResponse(undefined);
      onJobChanged(data.createAgentJob, true);
    } catch (value) {
      setError(
        value instanceof SyntaxError
          ? toolsT("invalidJsonObject")
          : value instanceof Error
            ? value.message
            : String(value),
      );
      setJob(null);
      setEventResponse(undefined);
    } finally {
      setBusy(false);
    }
  };

  const response = job
    ? { status: job.status, result: job.result, error: job.error }
    : eventResponse;
  const responseText =
    response === undefined ? "" : JSON.stringify(response, null, 2);
  const copyResponse = async () => {
    try {
      await copyText(responseText);
      setCopied(true);
    } catch {
      setError(toolsT("copyFailed"));
    }
  };

  return (
    <form className="grid gap-4 lg:grid-cols-2" onSubmit={run}>
      <div className="space-y-4">
        <h4 className="text-sm font-medium">{toolsT("parameters")}</h4>
        {eventCapability ? (
          <p className="text-sm text-muted-foreground">
            {t("eventCapabilityDescription")}
          </p>
        ) : (
          <div>
            <Label className="mb-1.5 block" htmlFor={`${capability}-payload`}>
              {t("payload")}
            </Label>
            <Textarea
              className="min-h-36 font-mono text-xs"
              id={`${capability}-payload`}
              onChange={(event) => setPayloadText(event.target.value)}
              spellCheck={false}
              value={payloadText}
            />
          </div>
        )}
        <Button disabled={busy || offline} type="submit">
          {busy ? <Spinner /> : <Wrench />}
          {busy ? toolsT("running") : t("invoke")}
        </Button>
        {offline && (
          <p className="text-xs text-muted-foreground">{t("invokeOffline")}</p>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <h4 className="text-sm font-medium">{toolsT("response")}</h4>
          {response !== undefined && (
            <Button
              aria-label={copied ? toolsT("copied") : toolsT("copyResponse")}
              onClick={() => void copyResponse()}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          )}
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : response === undefined ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {t("noCapabilityResponse")}
          </div>
        ) : (
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {responseText}
          </pre>
        )}
      </div>
    </form>
  );
}

function AgentCodebasesCard({
  codebases,
  locale,
}: {
  codebases: AgentCodebase[];
  locale: string;
}) {
  const t = useTranslations("agentDetail");
  const codebaseT = useTranslations("codebases");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("codebases")}</CardTitle>
        <CardDescription>{t("codebasesDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {codebases.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noCodebases")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("repository")}</TableHead>
                <TableHead>{codebaseT("folder")}</TableHead>
                <TableHead>{codebaseT("branch")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{codebaseT("lastChecked")}</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {codebases.map((codebase) => (
                <TableRow key={codebase.id}>
                  <TableCell>
                    <p className="font-medium">{codebase.repository.name}</p>
                    <p className="max-w-sm truncate font-mono text-xs text-muted-foreground">
                      {codebase.repository.displayOrigin}
                    </p>
                  </TableCell>
                  <TableCell className="max-w-sm truncate font-mono text-xs">
                    {codebase.folder}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {codebase.branch ??
                      codebase.headSha?.slice(0, 10) ??
                      codebaseT("unknown")}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={cn(
                        codebase.syncState === "IN_SYNC" &&
                          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      )}
                      variant="outline"
                    >
                      {codebase.availability === "AVAILABLE"
                        ? codebaseT(`sync.${codebase.syncState}`)
                        : codebaseT(`availability.${codebase.availability}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {codebase.lastCheckedAt
                      ? new Date(codebase.lastCheckedAt).toLocaleString(locale)
                      : codebaseT("never")}
                  </TableCell>
                  <TableCell>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/codebases/${codebase.id}`}>
                        {codebaseT("view")}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
