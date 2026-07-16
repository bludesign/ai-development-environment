"use client";

import {
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
} from "@ai-development-environment/agent-contract/codebases";
import {
  ChevronRight,
  Download,
  Folder,
  FolderGit2,
  Home,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import type { Agent } from "@/components/agents/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import type {
  Codebase,
  CodebaseRepository,
  DirectoryListing,
  Inspection,
} from "./types";

const RECONCILE_INTERVAL_MS = 30_000;
const CODEBASE_FIELDS = `
  id folder observedOrigin branch headSha upstream ahead behind syncState availability
  statusError lastCheckedAt lastFetchedAt
  agent { ${AGENT_FIELDS} }
  activeJob { id agentId kind payload status idempotencyKey result error timeoutSeconds createdAt startedAt finishedAt updatedAt }
`;
const REPOSITORY_FIELDS = `
  id canonicalOrigin displayOrigin name description createdAt updatedAt
  codebases { ${CODEBASE_FIELDS} }
`;

type GroupMode = "agents" | "repositories";

export function CodebasesPage() {
  const t = useTranslations("codebases");
  const [repositories, setRepositories] = useState<CodebaseRepository[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groupMode, setGroupMode] = useState<GroupMode>("agents");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CodebaseRepository | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        codebaseOverview: { repositories: CodebaseRepository[] };
        agents: Agent[];
      }>(`query CodebaseOverview {
        codebaseOverview { repositories { ${REPOSITORY_FIELDS} } }
        agents { ${AGENT_FIELDS} }
      }`);
      setRepositories(data.codebaseOverview.repositories);
      setAgents(data.agents);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const reconcile = window.setInterval(
      () => void load(),
      RECONCILE_INTERVAL_MS,
    );
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      codebaseOverviewChanged: { repositoryId: string };
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
      window.clearTimeout(initial);
      window.clearInterval(reconcile);
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

      <div
        aria-label={t("groupBy")}
        className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
        role="group"
      >
        <Button
          aria-pressed={groupMode === "agents"}
          onClick={() => setGroupMode("agents")}
          size="sm"
          variant={groupMode === "agents" ? "default" : "ghost"}
        >
          {t("agents")}
        </Button>
        <Button
          aria-pressed={groupMode === "repositories"}
          onClick={() => setGroupMode("repositories")}
          size="sm"
          variant={groupMode === "repositories" ? "default" : "ghost"}
        >
          {t("repositories")}
        </Button>
      </div>

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
        />
      ) : (
        <RepositoryGroups
          repositories={repositories}
          onEdit={setEditing}
          onFetch={(id) => runOperation("fetchCodebases", [id])}
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
      <EditRepositoryDialog
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

function AgentGroups({
  agents,
  entries,
  onFetch,
}: {
  agents: Agent[];
  entries: Array<{ codebase: Codebase; repository: CodebaseRepository }>;
  onFetch: (id: string) => Promise<void>;
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
}: {
  repositories: CodebaseRepository[];
  onEdit: (repository: CodebaseRepository) => void;
  onFetch: (id: string) => Promise<void>;
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
  showAgent,
  showMetadata = true,
}: {
  codebase: Codebase;
  repository: CodebaseRepository;
  onFetch: (id: string) => Promise<void>;
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
          <Button
            disabled={!canFetch}
            onClick={() => void onFetch(codebase.id)}
            size="sm"
            variant="outline"
          >
            {active ? <Spinner /> : <Download />} {t("fetch")}
          </Button>
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
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compatible = agents.filter(
    (agent) =>
      agent.connectionStatus === "ONLINE" &&
      agent.capabilities.includes(CODEBASE_BROWSE_JOB_KIND) &&
      agent.capabilities.includes(CODEBASE_INSPECT_JOB_KIND),
  );

  const reset = () => {
    setAgentId("");
    setListing(null);
    setInspection(null);
    setName("");
    setDescription("");
    setError(null);
    setShowHidden(false);
  };

  const browse = async (path: string | null) => {
    if (!agentId) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        browseAgentDirectory: DirectoryListing;
      }>(
        `mutation BrowseAgentDirectory($input: BrowseAgentDirectoryInput!) {
          browseAgentDirectory(input: $input) {
            path parentPath homePath truncated entries { name path hidden }
          }
        }`,
        { input: { agentId, path, requestId: createClientId() } },
      );
      setListing(data.browseAgentDirectory);
      setInspection(null);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async () => {
    if (!listing) return;
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
          input: { agentId, folder: listing.path, requestId: createClientId() },
        },
      );
      const next = data.inspectAgentCodebase;
      setInspection(next);
      const suggested = next.snapshot.displayOrigin.split("/").at(-1) ?? "";
      setName(next.existingRepository?.name ?? suggested);
      setDescription(next.existingRepository?.description ?? "");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
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

  const breadcrumbs = listing
    ? listing.path === "/"
      ? [{ label: "/", path: "/" }]
      : [
          { label: "/", path: "/" },
          ...listing.path
            .split("/")
            .filter(Boolean)
            .map((label, index, parts) => ({
              label,
              path: `/${parts.slice(0, index + 1).join("/")}`,
            })),
        ]
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-2xl">
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
            <select
              className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
              id="codebase-agent"
              onChange={(event) => {
                setAgentId(event.target.value);
                setListing(null);
                setInspection(null);
              }}
              value={agentId}
            >
              <option value="">{t("selectAgent")}</option>
              {compatible.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.hostname}
                </option>
              ))}
            </select>
          </div>
          {agentId && !listing && (
            <Button
              disabled={busy}
              onClick={() => void browse(null)}
              type="button"
              variant="outline"
            >
              {busy ? <Spinner /> : <Folder />} {t("browseHome")}
            </Button>
          )}
          {listing && !inspection && (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  aria-label={t("home")}
                  onClick={() => void browse(listing.homePath)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Home />
                </Button>
                {breadcrumbs.map((crumb, index) => (
                  <span className="flex items-center" key={crumb.path}>
                    {index > 0 && (
                      <ChevronRight className="size-3 text-muted-foreground" />
                    )}
                    <Button
                      onClick={() => void browse(crumb.path)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {crumb.label}
                    </Button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  checked={showHidden}
                  className="size-4"
                  id="show-hidden"
                  onChange={(event) => setShowHidden(event.target.checked)}
                  type="checkbox"
                />
                <Label htmlFor="show-hidden">{t("showHidden")}</Label>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border">
                {listing.entries
                  .filter((entry) => showHidden || !entry.hidden)
                  .map((entry) => (
                    <button
                      className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted"
                      key={entry.path}
                      onClick={() => void browse(entry.path)}
                      type="button"
                    >
                      <Folder className="size-4" /> {entry.name}
                    </button>
                  ))}
              </div>
              {listing.truncated && (
                <p className="text-xs text-muted-foreground">
                  {t("truncated")}
                </p>
              )}
              <Button
                disabled={busy}
                onClick={() => void inspect()}
                type="button"
              >
                {busy ? <Spinner /> : <FolderGit2 />} {t("selectFolder")}
              </Button>
            </div>
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
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditRepositoryDialog({
  repository,
  onOpenChange,
  onSaved,
}: {
  repository: CodebaseRepository | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("codebases");
  const [name, setName] = useState(repository?.name ?? "");
  const [description, setDescription] = useState(repository?.description ?? "");
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
        { input: { id: repository.id, name, description } },
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
