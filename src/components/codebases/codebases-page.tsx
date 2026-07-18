"use client";

import {
  CODEBASE_BROWSE_JOB_KIND,
  DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS,
} from "@ai-development-environment/agent-contract/codebases";
import {
  DEFAULT_JIRA_BRANCH_REGEX,
  DEFAULT_WORKTREE_FETCH_INTERVAL_SECONDS,
  MAX_WORKTREE_FETCH_INTERVAL_SECONDS,
  MIN_WORKTREE_FETCH_INTERVAL_SECONDS,
} from "@ai-development-environment/agent-contract/worktrees";
import {
  ArrowRight,
  Download,
  FolderGit2,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import { AgentDirectoryBrowser } from "@/components/agents/agent-directory-browser";
import type { Agent } from "@/components/agents/types";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  EmptyMedia,
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
import { Textarea } from "@/components/ui/textarea";
import { createClientId } from "@/lib/browser-utils";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import type {
  Codebase,
  CodebaseRepository,
  CodebaseSettings,
  Inspection,
} from "./types";

const RECONCILE_INTERVAL_MS = 30_000;
const OVERVIEW_EVENT_DEBOUNCE_MS = 100;
const CODEBASE_FIELDS = `
  id folder observedOrigin branch headSha upstream ahead behind syncState availability
  statusError defaultBranch localBranches remoteBranches lastCheckedAt lastFetchedAt lastFetchAttemptAt lastFetchError
  agent { ${AGENT_FIELDS} }
  activeJob { id agentId kind payload status idempotencyKey result error timeoutSeconds createdAt startedAt finishedAt updatedAt }
`;
const REPOSITORY_FIELDS = `
  id canonicalOrigin displayOrigin name description jiraBranchRegex keepBaseBranchUpToDate createdAt updatedAt
  skillGroups { id name }
  codebases { ${CODEBASE_FIELDS} }
`;

type GroupMode = "agents" | "repositories";

export function CodebasesPage() {
  const t = useTranslations("codebases");
  const [repositories, setRepositories] = useState<CodebaseRepository[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skillGroups, setSkillGroups] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [settings, setSettings] = useState<CodebaseSettings | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>("agents");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<CodebaseRepository | null>(null);
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++latestLoad.current;
    try {
      const data = await controlPlaneRequest<{
        codebaseOverview: { repositories: CodebaseRepository[] };
        codebaseSettings: CodebaseSettings;
        agents: Agent[];
        skillsOverview?: { groups: Array<{ id: string; name: string }> };
      }>(`query CodebaseOverview {
        codebaseOverview { repositories { ${REPOSITORY_FIELDS} } }
        codebaseSettings { refreshIntervalSeconds fetchIntervalSeconds defaultJiraBranchRegex updatedAt }
        agents { ${AGENT_FIELDS} }
        skillsOverview { groups { id name } }
      }`);
      if (loadId !== latestLoad.current) return;
      setRepositories(data.codebaseOverview.repositories);
      setSettings(data.codebaseSettings);
      setAgents(data.agents);
      setSkillGroups(data.skillsOverview?.groups ?? []);
      setError(null);
    } catch (value) {
      if (loadId !== latestLoad.current) return;
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (loadId === latestLoad.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let eventReload: number | null = null;
    const initial = window.setTimeout(() => void load(), 0);
    const reconcile = window.setInterval(
      () => void load(),
      RECONCILE_INTERVAL_MS,
    );
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      codebaseOverviewChanged: { repositoryId: string | null };
    }>(
      {
        query: `subscription CodebaseOverviewChanged {
          codebaseOverviewChanged { codebaseId repositoryId }
        }`,
      },
      {
        next: () => {
          if (eventReload !== null) window.clearTimeout(eventReload);
          eventReload = window.setTimeout(() => {
            eventReload = null;
            void load();
          }, OVERVIEW_EVENT_DEBOUNCE_MS);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(reconcile);
      if (eventReload !== null) window.clearTimeout(eventReload);
      latestLoad.current += 1;
      unsubscribe();
    };
  }, [load]);

  const codebases = useMemo(
    () =>
      repositories.flatMap((repository) =>
        repository.codebases.map((codebase) => ({ codebase, repository })),
      ),
    [repositories],
  );

  const runOperation = async (
    operation: "refreshCodebases" | "fetchCodebases",
    ids = codebases.map(({ codebase }) => codebase.id),
  ) => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        refreshCodebases?: { skipped: Array<{ reason: string }> };
        fetchCodebases?: { skipped: Array<{ reason: string }> };
      }>(
        `mutation RunCodebaseOperation($input: RunCodebaseOperationInput!) {
          ${operation}(input: $input) {
            jobs { id }
            skipped { codebaseId reason }
          }
        }`,
        { input: { codebaseIds: ids, requestId: createClientId() } },
      );
      const result = data[operation];
      setNotice(
        result?.skipped.length
          ? t("skipped", { count: result.skipped.length })
          : operation === "fetchCodebases"
            ? t("fetchQueued")
            : t("refreshQueued"),
      );
      setError(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const removeCodebase = async (id: string) => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation RemoveCodebase($id: ID!) {
          removeCodebase(id: $id) { id repositoryId repositoryRemoved }
        }`,
        { id },
      );
      setNotice(t("removed"));
      setError(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || codebases.length === 0}
            onClick={() => void runOperation("refreshCodebases")}
            variant="outline"
          >
            <RefreshCw className={busy ? "animate-spin" : undefined} />
            {t("refreshAll")}
          </Button>
          <Button
            disabled={busy || codebases.length === 0}
            onClick={() => void runOperation("fetchCodebases")}
            variant="outline"
          >
            <Download />
            {t("fetchAll")}
          </Button>
          <Button
            disabled={!settings}
            onClick={() => setSettingsOpen(true)}
            variant="outline"
          >
            <Settings2 />
            {t("settings")}
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus />
            {t("add")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Tabs
        onValueChange={(value) => setGroupMode(value as GroupMode)}
        value={groupMode}
      >
        <TabsList aria-label={t("groupBy")}>
          <TabsTrigger value="agents">{t("agents")}</TabsTrigger>
          <TabsTrigger value="repositories">{t("repositories")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : codebases.length === 0 ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2 />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : groupMode === "agents" ? (
        <AgentGroups
          agents={agents}
          entries={codebases}
          onFetch={(id) => runOperation("fetchCodebases", [id])}
          onRemove={removeCodebase}
        />
      ) : (
        <RepositoryGroups
          repositories={repositories}
          onEdit={setEditing}
          onFetch={(id) => runOperation("fetchCodebases", [id])}
          onRemove={removeCodebase}
        />
      )}

      <AddCodebaseDialog
        agents={agents}
        onAdded={async () => {
          setAddOpen(false);
          await load();
        }}
        onOpenChange={setAddOpen}
        open={addOpen}
      />
      <CodebaseSettingsDialog
        key={`${settingsOpen ? "open" : "closed"}-${settings?.refreshIntervalSeconds ?? DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS}`}
        onOpenChange={setSettingsOpen}
        onSaved={(nextSettings) => {
          setSettings(nextSettings);
          setSettingsOpen(false);
          setNotice(t("settingsSaved"));
          setError(null);
        }}
        open={settingsOpen}
        settings={settings}
      />
      <EditRepositoryDialog
        groups={skillGroups}
        key={editing?.id ?? "closed"}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
        repository={editing}
      />
    </section>
  );
}

function CodebaseSettingsDialog({
  open,
  settings,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  settings: CodebaseSettings | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (settings: CodebaseSettings) => void;
}) {
  const t = useTranslations("codebases");
  const [value, setValue] = useState(
    String(
      settings?.refreshIntervalSeconds ??
        DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS,
    ),
  );
  const [fetchValue, setFetchValue] = useState(
    String(
      settings?.fetchIntervalSeconds ?? DEFAULT_WORKTREE_FETCH_INTERVAL_SECONDS,
    ),
  );
  const [jiraRegex, setJiraRegex] = useState(
    settings?.defaultJiraBranchRegex ?? DEFAULT_JIRA_BRANCH_REGEX,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshIntervalSeconds = Number(value);
  const valid =
    Number.isInteger(refreshIntervalSeconds) &&
    refreshIntervalSeconds >= MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS &&
    refreshIntervalSeconds <= MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS;
  const fetchIntervalSeconds = Number(fetchValue);
  const fetchValid =
    Number.isInteger(fetchIntervalSeconds) &&
    fetchIntervalSeconds >= MIN_WORKTREE_FETCH_INTERVAL_SECONDS &&
    fetchIntervalSeconds <= MAX_WORKTREE_FETCH_INTERVAL_SECONDS;
  let regexValid = true;
  try {
    if (jiraRegex) void new RegExp(jiraRegex, "i");
  } catch {
    regexValid = false;
  }

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || !fetchValid || !regexValid) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        updateCodebaseSettings: CodebaseSettings;
      }>(
        `mutation UpdateCodebaseSettings($input: UpdateCodebaseSettingsInput!) {
          updateCodebaseSettings(input: $input) {
            refreshIntervalSeconds fetchIntervalSeconds defaultJiraBranchRegex updatedAt
          }
        }`,
        {
          input: {
            refreshIntervalSeconds,
            fetchIntervalSeconds,
            defaultJiraBranchRegex: jiraRegex,
          },
        },
      );
      onSaved(data.updateCodebaseSettings);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settingsTitle")}</DialogTitle>
          <DialogDescription>{t("settingsDescription")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={save}>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="codebase-refresh-interval">
              {t("refreshInterval")}
            </Label>
            <Input
              id="codebase-refresh-interval"
              inputMode="numeric"
              max={MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS}
              min={MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS}
              onChange={(event) => setValue(event.target.value)}
              required
              step={1}
              type="number"
              value={value}
            />
            <p className="text-xs text-muted-foreground">
              {t("refreshIntervalHelp", {
                min: MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS,
                max: MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS,
              })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="codebase-fetch-interval">
              {t("fetchInterval")}
            </Label>
            <Input
              id="codebase-fetch-interval"
              inputMode="numeric"
              max={MAX_WORKTREE_FETCH_INTERVAL_SECONDS}
              min={MIN_WORKTREE_FETCH_INTERVAL_SECONDS}
              onChange={(event) => setFetchValue(event.target.value)}
              required
              step={1}
              type="number"
              value={fetchValue}
            />
            <p className="text-xs text-muted-foreground">
              {t("fetchIntervalHelp", {
                min: MIN_WORKTREE_FETCH_INTERVAL_SECONDS,
                max: MAX_WORKTREE_FETCH_INTERVAL_SECONDS,
              })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="default-jira-branch-regex">
              {t("defaultJiraBranchRegex")}
            </Label>
            <Input
              id="default-jira-branch-regex"
              onChange={(event) => setJiraRegex(event.target.value)}
              value={jiraRegex}
            />
            <p className="text-xs text-muted-foreground">
              {t("jiraBranchRegexHelp")}
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !valid || !fetchValid || !regexValid}
              type="submit"
            >
              {busy && <Spinner />} {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentGroups({
  agents,
  entries,
  onFetch,
  onRemove,
}: {
  agents: Agent[];
  entries: Array<{ codebase: Codebase; repository: CodebaseRepository }>;
  onFetch: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const t = useTranslations("codebases");
  return (
    <div className="space-y-6">
      {agents
        .map((agent) => ({
          agent,
          entries: entries.filter(
            ({ codebase }) => codebase.agent.id === agent.id,
          ),
        }))
        .filter(({ entries: items }) => items.length > 0)
        .map(({ agent, entries: items }) => (
          <section key={agent.id} className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{agent.name}</h2>
              <span className="text-sm text-muted-foreground">
                {agent.hostname}
              </span>
              <Badge>
                {agent.connectionStatus === "ONLINE"
                  ? t("online")
                  : t("offline")}
              </Badge>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {items.map(({ codebase, repository }) => (
                <CodebaseCard
                  codebase={codebase}
                  key={codebase.id}
                  onFetch={onFetch}
                  onRemove={onRemove}
                  repository={repository}
                  showAgent={false}
                />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

function RepositoryGroups({
  repositories,
  onEdit,
  onFetch,
  onRemove,
}: {
  repositories: CodebaseRepository[];
  onEdit: (repository: CodebaseRepository) => void;
  onFetch: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const t = useTranslations("codebases");
  return (
    <div className="space-y-6">
      {repositories.map((repository) => (
        <section key={repository.id} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{repository.name}</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {repository.displayOrigin}
              </p>
              {repository.description && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {repository.description}
                </p>
              )}
            </div>
            <Button
              onClick={() => onEdit(repository)}
              size="sm"
              variant="outline"
            >
              <Pencil /> {t("edit")}
            </Button>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {repository.codebases.map((codebase) => (
              <CodebaseCard
                codebase={codebase}
                key={codebase.id}
                onFetch={onFetch}
                onRemove={onRemove}
                repository={repository}
                showAgent
                showMetadata={false}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CodebaseCard({
  codebase,
  repository,
  onFetch,
  onRemove,
  showAgent,
  showMetadata = true,
}: {
  codebase: Codebase;
  repository: CodebaseRepository;
  onFetch: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  showAgent: boolean;
  showMetadata?: boolean;
}) {
  const t = useTranslations("codebases");
  const locale = useLocale();
  const active = codebase.activeJob;
  const canFetch =
    codebase.agent.connectionStatus === "ONLINE" &&
    codebase.agent.capabilities.includes(CODEBASE_FETCH_JOB_KIND) &&
    codebase.availability === "AVAILABLE" &&
    !active;
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : t("never");
  const syncLabel =
    codebase.syncState === "AHEAD" || codebase.syncState === "BEHIND"
      ? t(codebase.syncState.toLowerCase(), {
          count:
            codebase.syncState === "AHEAD"
              ? (codebase.ahead ?? 0)
              : (codebase.behind ?? 0),
        })
      : t(`sync.${codebase.syncState}`);
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {showMetadata && <h3 className="font-medium">{repository.name}</h3>}
            {showAgent && (
              <h3 className="font-medium">{codebase.agent.name}</h3>
            )}
            {showMetadata && repository.description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {repository.description}
              </p>
            )}
          </div>
          <Badge
            className={cn(
              codebase.syncState === "IN_SYNC" &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {syncLabel}
          </Badge>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Info label={t("folder")} value={codebase.folder} mono />
          <Info label={t("origin")} value={codebase.observedOrigin} mono />
          <Info
            label={t("branch")}
            value={
              codebase.branch ?? codebase.headSha?.slice(0, 10) ?? t("unknown")
            }
            mono
          />
          <Info
            label={t("upstream")}
            value={codebase.upstream ?? t("none")}
            mono
          />
          <Info label={t("lastChecked")} value={date(codebase.lastCheckedAt)} />
          <Info label={t("lastFetched")} value={date(codebase.lastFetchedAt)} />
        </dl>
        {(codebase.statusError || codebase.availability !== "AVAILABLE") && (
          <Alert variant="destructive">
            <AlertDescription>
              {codebase.statusError ??
                t(`availability.${codebase.availability}`)}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {active
              ? t("operationRunning")
              : codebase.agent.connectionStatus === "OFFLINE"
                ? t("offline")
                : ""}
          </p>
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/codebases/${codebase.id}`}>
                {t("view")} <ArrowRight />
              </Link>
            </Button>
            <ConfirmationDialog
              actionLabel={t("remove")}
              cancelLabel={t("cancel")}
              description={t("confirmRemoveDescription", {
                folder: codebase.folder,
              })}
              onConfirm={() => onRemove(codebase.id)}
              title={t("confirmRemoveTitle")}
              trigger={
                <Button
                  disabled={Boolean(active)}
                  size="sm"
                  variant="destructive"
                >
                  <Trash2 /> {t("remove")}
                </Button>
              }
            />
            <Button
              disabled={!canFetch}
              onClick={() => void onFetch(codebase.id)}
              size="sm"
              variant="outline"
            >
              {active ? <Spinner /> : <Download />} {t("fetch")}
            </Button>
          </div>
        </div>
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

function AddCodebaseDialog({
  agents,
  open,
  onOpenChange,
  onAdded,
}: {
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => Promise<void>;
}) {
  const t = useTranslations("codebases");
  const [agentId, setAgentId] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const compatible = agents.filter(
    (agent) =>
      agent.connectionStatus === "ONLINE" &&
      agent.capabilities.includes(CODEBASE_BROWSE_JOB_KIND) &&
      agent.capabilities.includes(CODEBASE_INSPECT_JOB_KIND),
  );
  const selectedAgent = compatible.find((agent) => agent.id === agentId);

  const reset = () => {
    requestSequence.current += 1;
    setAgentId("");
    setSelectedFolder(null);
    setInspection(null);
    setName("");
    setDescription("");
    setError(null);
    setBusy(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const inspect = async (folder: string) => {
    const requestId = ++requestSequence.current;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        inspectAgentCodebase: Inspection;
      }>(
        `mutation InspectAgentCodebase($input: InspectAgentCodebaseInput!) {
          inspectAgentCodebase(input: $input) {
            jobId
            snapshot { folder observedOrigin canonicalOrigin displayOrigin branch syncState }
            existingRepository { id canonicalOrigin displayOrigin name description createdAt updatedAt }
          }
        }`,
        {
          input: { agentId, folder, requestId: createClientId() },
        },
      );
      if (requestId !== requestSequence.current) return;
      const next = data.inspectAgentCodebase;
      setInspection(next);
      const suggested = next.snapshot.displayOrigin.split("/").at(-1) ?? "";
      setName(next.existingRepository?.name ?? suggested);
      setDescription(next.existingRepository?.description ?? "");
      setError(null);
    } catch (value) {
      if (requestId !== requestSequence.current) return;
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (requestId === requestSequence.current) setBusy(false);
    }
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!inspection) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation ConfirmCodebase($input: ConfirmCodebaseInput!) {
          confirmCodebase(input: $input) { id }
        }`,
        { input: { inspectionJobId: inspection.jobId, name, description } },
      );
      reset();
      await onAdded();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={confirm}>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="codebase-agent">{t("agent")}</Label>
            <Select
              onValueChange={(value) => {
                requestSequence.current += 1;
                setAgentId(value);
                setSelectedFolder(null);
                setInspection(null);
                setBusy(false);
                setError(null);
              }}
              value={agentId}
            >
              <SelectTrigger className="w-full" id="codebase-agent">
                <SelectValue placeholder={t("selectAgent")} />
              </SelectTrigger>
              <SelectContent>
                {compatible.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} · {agent.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {agentId && !inspection && (
            <AgentDirectoryBrowser
              agentId={agentId}
              disabled={busy}
              initialPath={selectedAgent?.baseRepoDirectory}
              key={agentId}
              onPathChange={setSelectedFolder}
            />
          )}
          {inspection && (
            <div className="space-y-4 rounded-lg border p-4">
              <Info
                label={t("folder")}
                value={inspection.snapshot.folder}
                mono
              />
              <Info
                label={t("origin")}
                value={inspection.snapshot.displayOrigin}
                mono
              />
              <Info
                label={t("branch")}
                value={inspection.snapshot.branch ?? t("detached")}
                mono
              />
              {inspection.existingRepository ? (
                <Alert>
                  <AlertDescription>
                    {t("existingOrigin", {
                      name: inspection.existingRepository.name,
                    })}
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="codebase-name">{t("name")}</Label>
                    <Input
                      id="codebase-name"
                      maxLength={120}
                      onChange={(event) => setName(event.target.value)}
                      required
                      value={name}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="codebase-description">
                      {t("repositoryDescription")}
                    </Label>
                    <Textarea
                      id="codebase-description"
                      maxLength={2000}
                      onChange={(event) => setDescription(event.target.value)}
                      value={description}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
            {selectedFolder && !inspection && (
              <Button
                disabled={busy}
                onClick={() => void inspect(selectedFolder)}
                type="button"
              >
                {busy ? <Spinner /> : <FolderGit2 />} {t("addFolder")}
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                onClick={() => handleOpenChange(false)}
                type="button"
                variant="outline"
              >
                {t("cancel")}
              </Button>
              {inspection && (
                <Button
                  disabled={
                    busy || (!inspection.existingRepository && !name.trim())
                  }
                  type="submit"
                >
                  {busy && <Spinner />} {t("confirm")}
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditRepositoryDialog({
  groups,
  repository,
  onOpenChange,
  onSaved,
}: {
  groups: Array<{ id: string; name: string }>;
  repository: CodebaseRepository | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("codebases");
  const [name, setName] = useState(repository?.name ?? "");
  const [description, setDescription] = useState(repository?.description ?? "");
  const [jiraBranchRegex, setJiraBranchRegex] = useState(
    repository?.jiraBranchRegex ?? "",
  );
  const [keepBaseBranchUpToDate, setKeepBaseBranchUpToDate] = useState(
    repository?.keepBaseBranchUpToDate ?? true,
  );
  const [skillGroupIds, setSkillGroupIds] = useState(
    repository?.skillGroups?.map((group) => group.id) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!repository) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation UpdateCodebaseRepository($input: UpdateCodebaseRepositoryInput!) {
          updateCodebaseRepository(input: $input) { id }
        }`,
        {
          input: {
            id: repository.id,
            name,
            description,
            jiraBranchRegex: jiraBranchRegex || null,
            keepBaseBranchUpToDate,
            skillGroupIds,
          },
        },
      );
      await onSaved();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(repository)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
          <DialogDescription>{repository?.displayOrigin}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={save}>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="edit-codebase-name">{t("name")}</Label>
            <Input
              id="edit-codebase-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-codebase-jira-regex">
              {t("jiraBranchRegex")}
            </Label>
            <Input
              id="edit-codebase-jira-regex"
              onChange={(event) => setJiraBranchRegex(event.target.value)}
              placeholder={t("inheritDefaultRegex")}
              value={jiraBranchRegex}
            />
            <p className="text-xs text-muted-foreground">
              {t("jiraBranchRegexHelp")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-codebase-description">
              {t("repositoryDescription")}
            </Label>
            <Textarea
              id="edit-codebase-description"
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </div>
          <div className="flex items-start gap-3 rounded-lg border p-3">
            <Checkbox
              checked={keepBaseBranchUpToDate}
              className="mt-0.5"
              id="edit-codebase-keep-base-branch-up-to-date"
              onCheckedChange={(checked) =>
                setKeepBaseBranchUpToDate(checked === true)
              }
            />
            <div className="space-y-1">
              <Label htmlFor="edit-codebase-keep-base-branch-up-to-date">
                {t("keepBaseBranchUpToDate")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("keepBaseBranchUpToDateHelp")}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t("skillGroups")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("skillGroupsHelp")}
            </p>
            <div className="max-h-40 space-y-1 overflow-auto rounded-lg border p-2">
              {groups.map((group) => (
                <label
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                  key={group.id}
                >
                  <Checkbox
                    checked={skillGroupIds.includes(group.id)}
                    onCheckedChange={(checked) =>
                      setSkillGroupIds((current) =>
                        checked === true
                          ? [...new Set([...current, group.id])]
                          : current.filter((id) => id !== group.id),
                      )
                    }
                  />
                  {group.name}
                </label>
              ))}
              {!groups.length && (
                <p className="px-2 py-1 text-sm text-muted-foreground">
                  {t("noSkillGroups")}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button disabled={busy} type="submit">
              {busy && <Spinner />} {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
