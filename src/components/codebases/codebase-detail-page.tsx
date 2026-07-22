"use client";

import {
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_GIT_INSPECT_JOB_KIND,
  CODEBASE_GIT_OPERATION_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
  type CodebaseGitOperation,
} from "@ai-development-environment/agent-contract/codebases";
import {
  ArchiveRestore,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  GitBranch,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { AGENT_FIELDS, JOB_FIELDS } from "@/components/agents/graphql-fields";
import type { AgentJob } from "@/components/agents/types";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/common/date-time";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { PatchView } from "@/components/common/patch-view";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import { copyText, createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import type {
  CodebaseDetail,
  CodebaseGitBranch,
  CodebaseGitState,
  CodebaseStash,
  CodebaseStashDiff,
} from "./types";

const CODEBASE_DETAIL_FIELDS = `
  id folder observedOrigin branch headSha upstream ahead behind syncState availability
  statusError defaultBranch localBranches remoteBranches lastCheckedAt lastFetchedAt lastFetchAttemptAt lastFetchError
  agent { ${AGENT_FIELDS} }
  repository { id canonicalOrigin displayOrigin name description jiraBranchRegex keepBaseBranchUpToDate createdAt updatedAt }
  activeJob { ${JOB_FIELDS} }
`;
const FINAL_JOB_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

type DiffEntry = {
  open: boolean;
  loading: boolean;
  diff?: CodebaseStashDiff;
  error?: string;
};

type CopyState = "IDLE" | "COPIED" | "FAILED";

type BranchSort = "NAME" | "DATE";

function liveInspectionAvailable(codebase: CodebaseDetail) {
  return (
    codebase.agent.connectionStatus === "ONLINE" &&
    codebase.availability === "AVAILABLE" &&
    codebase.agent.capabilities.includes(CODEBASE_GIT_INSPECT_JOB_KIND)
  );
}

function persistedState(codebase: CodebaseDetail): CodebaseGitState {
  const local = new Set(codebase.localBranches);
  const remote = new Set(codebase.remoteBranches);
  if (codebase.branch) local.add(codebase.branch);
  return {
    dirty: false,
    branches: [...new Set([...local, ...remote])]
      .sort((first, second) => first.localeCompare(second))
      .map((name) => ({
        name,
        local: local.has(name),
        remote: remote.has(name),
        current: name === codebase.branch,
        checkedOutPath: name === codebase.branch ? codebase.folder : null,
        // Branch tips are only known from a live inspection.
        lastCommitMessage: null,
        lastCommitAt: null,
      })),
    branchesTruncated: false,
    stashes: [],
    stashesTruncated: false,
  };
}

export function CodebaseDetailPage({ codebaseId }: { codebaseId: string }) {
  const t = useTranslations("codebaseDetail");
  const codebaseT = useTranslations("codebases");
  const [codebase, setCodebase] = useState<CodebaseDetail | null>(null);
  const [gitState, setGitState] = useState<CodebaseGitState | null>(null);
  const [loading, setLoading] = useState(true);
  const [inspecting, setInspecting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffEntry>>({});

  const inspectState = useCallback(async () => {
    setInspecting(true);
    try {
      const data = await controlPlaneRequest<{
        inspectCodebaseGitState: CodebaseGitState;
      }>(
        `mutation InspectCodebaseGitState($input: InspectCodebaseGitStateInput!) {
          inspectCodebaseGitState(input: $input) {
            dirty branchesTruncated stashesTruncated
            branches { name local remote current checkedOutPath lastCommitMessage lastCommitAt }
            stashes { oid selector message createdAt }
          }
        }`,
        { input: { codebaseId, requestId: createClientId() } },
      );
      setGitState(data.inspectCodebaseGitState);
      setDiffs({});
      setLoadError(null);
      return true;
    } catch (value) {
      setLoadError(value instanceof Error ? value.message : String(value));
      return false;
    } finally {
      setInspecting(false);
    }
  }, [codebaseId]);

  const load = useCallback(
    async (includeLiveState = true) => {
      try {
        const data = await controlPlaneRequest<{
          codebase: CodebaseDetail | null;
        }>(
          `query CodebaseDetail($id: ID!) {
            codebase(id: $id) { ${CODEBASE_DETAIL_FIELDS} }
          }`,
          { id: codebaseId },
        );
        const next = data.codebase;
        setCodebase(next);
        setLoadError(null);
        if (!next) {
          setGitState(null);
        } else if (
          includeLiveState &&
          !next.activeJob &&
          liveInspectionAvailable(next)
        ) {
          if (!(await inspectState())) {
            setGitState(persistedState(next));
          }
        } else if (!liveInspectionAvailable(next)) {
          setGitState(persistedState(next));
        } else {
          setGitState((current) => current ?? persistedState(next));
        }
      } catch (value) {
        setLoadError(value instanceof Error ? value.message : String(value));
      } finally {
        setLoading(false);
      }
    },
    [codebaseId, inspectState],
  );

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => void load(false), 30_000);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      codebaseOverviewChanged: {
        codebaseId: string | null;
        repositoryId: string | null;
      };
    }>(
      {
        query: `subscription CodebaseDetailChanged {
          codebaseOverviewChanged { codebaseId repositoryId }
        }`,
      },
      {
        next: (value) => {
          const changed = value.data?.codebaseOverviewChanged;
          if (
            !changed ||
            changed.codebaseId === null ||
            changed.codebaseId === codebaseId
          ) {
            void load();
          }
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(refresh);
      unsubscribe();
    };
  }, [codebaseId, load]);

  const activeJob = codebase?.activeJob ?? null;
  useEffect(() => {
    if (!activeJob) return;
    return controlPlaneSubscriptions().subscribe<{ agentJobChanged: AgentJob }>(
      {
        query: `subscription CodebaseJobChanged($jobId: ID!) {
          agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} }
        }`,
        variables: { jobId: activeJob.id },
      },
      {
        next: (value) => {
          const changed = value.data?.agentJobChanged;
          if (!changed) return;
          if (FINAL_JOB_STATUSES.has(changed.status)) {
            if (changed.status === "SUCCEEDED") {
              setNotice(t("operationSucceeded"));
              setOperationError(null);
            } else {
              setOperationError(changed.error || t("operationFailed"));
              setNotice(null);
            }
            setCodebase((current) =>
              current ? { ...current, activeJob: null } : current,
            );
            void load();
          } else {
            setCodebase((current) =>
              current ? { ...current, activeJob: changed } : current,
            );
          }
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
  }, [activeJob, load, t]);

  const queueBatch = async (
    operation: "refreshCodebases" | "fetchCodebases",
  ) => {
    setOperationError(null);
    setNotice(null);
    try {
      const data = await controlPlaneRequest<{
        refreshCodebases?: {
          jobs: AgentJob[];
          skipped: Array<{ reason: string }>;
        };
        fetchCodebases?: {
          jobs: AgentJob[];
          skipped: Array<{ reason: string }>;
        };
      }>(
        `mutation RunCodebaseDetailOperation($input: RunCodebaseOperationInput!) {
          ${operation}(input: $input) {
            jobs { ${JOB_FIELDS} }
            skipped { codebaseId reason }
          }
        }`,
        { input: { codebaseIds: [codebaseId], requestId: createClientId() } },
      );
      const result = data[operation];
      const job = result?.jobs[0];
      if (!job) {
        throw new Error(result?.skipped[0]?.reason || t("operationFailed"));
      }
      setCodebase((current) =>
        current ? { ...current, activeJob: job } : current,
      );
      setNotice(t("operationQueued"));
    } catch (value) {
      setOperationError(value instanceof Error ? value.message : String(value));
    }
  };

  const runGitOperation = async (
    operation: CodebaseGitOperation,
    values: { branch?: string; stashOid?: string; stashChanges?: boolean },
  ) => {
    setOperationError(null);
    setNotice(null);
    try {
      const data = await controlPlaneRequest<{
        runCodebaseGitOperation: AgentJob;
      }>(
        `mutation RunCodebaseGitOperation($input: RunCodebaseGitOperationInput!) {
          runCodebaseGitOperation(input: $input) { ${JOB_FIELDS} }
        }`,
        {
          input: {
            codebaseId,
            operation,
            ...values,
            requestId: createClientId(),
          },
        },
      );
      setCodebase((current) =>
        current
          ? { ...current, activeJob: data.runCodebaseGitOperation }
          : current,
      );
      setNotice(t("operationQueued"));
    } catch (value) {
      setOperationError(value instanceof Error ? value.message : String(value));
    }
  };

  const toggleDiff = async (stash: CodebaseStash) => {
    const current = diffs[stash.oid];
    if (current?.open) {
      setDiffs((values) => ({
        ...values,
        [stash.oid]: { ...current, open: false },
      }));
      return;
    }
    if (current?.diff) {
      setDiffs((values) => ({
        ...values,
        [stash.oid]: { ...current, open: true },
      }));
      return;
    }
    setDiffs((values) => ({
      ...values,
      [stash.oid]: { open: true, loading: true },
    }));
    setInspecting(true);
    try {
      const data = await controlPlaneRequest<{
        inspectCodebaseStash: CodebaseStashDiff;
      }>(
        `mutation InspectCodebaseStash($input: InspectCodebaseStashInput!) {
          inspectCodebaseStash(input: $input) { oid patch truncated }
        }`,
        {
          input: {
            codebaseId,
            stashOid: stash.oid,
            requestId: createClientId(),
          },
        },
      );
      setDiffs((values) => ({
        ...values,
        [stash.oid]: {
          open: true,
          loading: false,
          diff: data.inspectCodebaseStash,
        },
      }));
    } catch (value) {
      setDiffs((values) => ({
        ...values,
        [stash.oid]: {
          open: true,
          loading: false,
          error: value instanceof Error ? value.message : String(value),
        },
      }));
    } finally {
      setInspecting(false);
    }
  };

  if (loading) {
    return (
      <p className="mx-auto flex max-w-6xl items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }
  if (!codebase) {
    return (
      <Empty className="mx-auto max-w-6xl border py-12">
        <EmptyHeader>
          <EmptyTitle>{t("notFound")}</EmptyTitle>
          <EmptyDescription>{t("notFoundDescription")}</EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href="/codebases">
            <ArrowLeft /> {t("back")}
          </Link>
        </Button>
      </Empty>
    );
  }

  const canInspect = liveInspectionAvailable(codebase);
  const canOperate =
    canInspect &&
    codebase.agent.capabilities.includes(CODEBASE_GIT_OPERATION_JOB_KIND);
  const busy = Boolean(activeJob) || inspecting;
  const localBranches =
    gitState?.branches.filter((branch) => branch.local) ?? [];
  const remoteBranches =
    gitState?.branches.filter((branch) => branch.remote) ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/codebases">
            <ArrowLeft /> {t("back")}
          </Link>
        </Button>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {operationError && (
        <Alert variant="destructive">
          <AlertDescription>{operationError}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {(!canInspect || !canOperate) && (
        <Alert>
          <AlertDescription>
            {codebase.agent.connectionStatus === "OFFLINE"
              ? t("offlineReadOnly")
              : codebase.availability !== "AVAILABLE"
                ? codebase.statusError ||
                  codebaseT(`availability.${codebase.availability}`)
                : t("unsupportedReadOnly")}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {codebase.repository.name}
                </h1>
                <Badge>{codebaseT(`sync.${codebase.syncState}`)}</Badge>
                {gitState?.dirty && (
                  <Badge variant="destructive">{t("dirty")}</Badge>
                )}
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {codebase.folder}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {codebase.agent.name} · {codebase.agent.hostname}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link
                  href={`/codebases/repositories/${codebase.repository.id}`}
                >
                  <Settings2 /> {t("repositorySettings")}
                </Link>
              </Button>
              <Button
                disabled={
                  busy ||
                  codebase.agent.connectionStatus !== "ONLINE" ||
                  !codebase.agent.capabilities.includes(
                    CODEBASE_REFRESH_JOB_KIND,
                  )
                }
                onClick={() => void queueBatch("refreshCodebases")}
                variant="outline"
              >
                {busy ? <Spinner /> : <RefreshCw />} {t("refresh")}
              </Button>
              <Button
                disabled={
                  busy ||
                  codebase.agent.connectionStatus !== "ONLINE" ||
                  codebase.availability !== "AVAILABLE" ||
                  !codebase.agent.capabilities.includes(CODEBASE_FETCH_JOB_KIND)
                }
                onClick={() => void queueBatch("fetchCodebases")}
                variant="outline"
              >
                {activeJob?.kind === CODEBASE_FETCH_JOB_KIND ? (
                  <Spinner />
                ) : (
                  <Download />
                )}{" "}
                {t("fetch")}
              </Button>
            </div>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Info label={t("origin")} value={codebase.observedOrigin} mono />
            <Info
              label={t("currentBranch")}
              value={codebase.branch ?? codebaseT("detached")}
              mono
            />
            <Info
              label={t("upstream")}
              value={codebase.upstream ?? codebaseT("none")}
              mono
            />
            <Info
              label={t("lastFetched")}
              small
              value={
                <DateTime
                  fallback={codebaseT("never")}
                  value={codebase.lastFetchedAt}
                />
              }
            />
          </dl>
          {activeJob && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("activeOperation", { kind: activeJob.kind })}
            </p>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="branches">
        <TabsList>
          <TabsTrigger value="branches">
            {t("branches", { count: gitState?.branches.length ?? 0 })}
          </TabsTrigger>
          <TabsTrigger value="stashes">
            {t("stashes", { count: gitState?.stashes.length ?? 0 })}
          </TabsTrigger>
        </TabsList>
        <TabsContent className="space-y-6" value="branches">
          <BranchTable
            branches={localBranches}
            busy={busy}
            canOperate={canOperate}
            defaultBranch={codebase.defaultBranch}
            dirty={Boolean(gitState?.dirty)}
            kind="local"
            onOperation={runGitOperation}
          />
          <BranchTable
            branches={remoteBranches}
            busy={busy}
            canOperate={canOperate}
            defaultBranch={codebase.defaultBranch}
            dirty={Boolean(gitState?.dirty)}
            kind="remote"
            onOperation={runGitOperation}
          />
          {gitState?.branchesTruncated && (
            <p className="text-xs text-muted-foreground">
              {t("branchesTruncated")}
            </p>
          )}
        </TabsContent>
        <TabsContent value="stashes">
          <StashTable
            busy={busy}
            canOperate={canOperate}
            diffs={diffs}
            onOperation={runGitOperation}
            onToggleDiff={toggleDiff}
            stashes={gitState?.stashes ?? []}
            truncated={Boolean(gitState?.stashesTruncated)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The header band holding a card's title and its filter controls. The controls
 * take their own row until there is room to sit beside the title, so they never
 * push the header wider than the card.
 */
function TableToolbar({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <CardHeader className="gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
      <CardTitle>{title}</CardTitle>
      <div className="flex flex-wrap items-center gap-2 sm:col-start-2 sm:row-start-1 sm:justify-end">
        {children}
      </div>
    </CardHeader>
  );
}

/** The search field the branch and stash cards share in their header. */
function TableSearch({
  label,
  placeholder,
  onChange,
  value,
}: {
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="relative min-w-40 flex-1 sm:w-64 sm:flex-none">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={label}
        className="pl-9"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </div>
  );
}

function BranchTable({
  branches,
  kind,
  busy,
  canOperate,
  defaultBranch,
  dirty,
  onOperation,
}: {
  branches: CodebaseGitBranch[];
  kind: "local" | "remote";
  busy: boolean;
  canOperate: boolean;
  defaultBranch: string | null;
  dirty: boolean;
  onOperation: (
    operation: CodebaseGitOperation,
    values: { branch?: string; stashChanges?: boolean },
  ) => Promise<void>;
}) {
  const t = useTranslations("codebaseDetail");
  const title = kind === "local" ? t("localBranches") : t("remoteBranches");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BranchSort>("NAME");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? branches.filter((branch) => branch.name.toLowerCase().includes(needle))
      : branches;
    if (sort === "NAME") {
      return [...matches].sort((first, second) =>
        first.name.localeCompare(second.name),
      );
    }
    // Newest commit first. Branches whose tip the agent could not report sort
    // last, then by name so the order stays stable.
    return [...matches].sort((first, second) => {
      if (first.lastCommitAt !== second.lastCommitAt) {
        if (!first.lastCommitAt) return 1;
        if (!second.lastCommitAt) return -1;
        return second.lastCommitAt.localeCompare(first.lastCommitAt);
      }
      return first.name.localeCompare(second.name);
    });
  }, [branches, query, sort]);

  if (branches.length === 0) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranch />
            </EmptyMedia>
            <EmptyDescription>
              {kind === "local" ? t("noLocalBranches") : t("noRemoteBranches")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <TableToolbar title={title}>
        <TableSearch
          label={t("searchBranches")}
          onChange={setQuery}
          placeholder={t("searchBranchesPlaceholder")}
          value={query}
        />
        <Select
          onValueChange={(value) => setSort(value as BranchSort)}
          value={sort}
        >
          <SelectTrigger
            aria-label={t("sortBranches")}
            className="w-40 shrink-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="NAME">{t("sortByName")}</SelectItem>
            <SelectItem value="DATE">{t("sortByNewestCommit")}</SelectItem>
          </SelectContent>
        </Select>
      </TableToolbar>
      {visible.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          {t("noMatchingBranches")}
        </p>
      ) : (
        <Table aria-label={title}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("branchName")}</TableHead>
              <TableHead>{t("branchStatus")}</TableHead>
              <TableHead className="text-right">{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((branch) => {
              const elsewhere = Boolean(
                branch.checkedOutPath && !branch.current,
              );
              const defaultBranchProtected = branch.name === defaultBranch;
              const remoteMainProtected =
                kind === "remote" && branch.name === "main";
              return (
                <TableRow key={branch.name}>
                  <TableCell className="max-w-md align-top whitespace-normal">
                    <span className="font-mono text-xs">{branch.name}</span>
                    {(branch.lastCommitMessage || branch.lastCommitAt) && (
                      <span className="mt-0.5 block text-xs font-normal break-words text-muted-foreground">
                        {branch.lastCommitMessage}
                        {branch.lastCommitMessage &&
                          branch.lastCommitAt &&
                          " · "}
                        {branch.lastCommitAt && (
                          <DateTime value={branch.lastCommitAt} />
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      {branch.current && <Badge>{t("current")}</Badge>}
                      {defaultBranchProtected && (
                        <Badge variant="outline">{t("default")}</Badge>
                      )}
                      {remoteMainProtected && !defaultBranchProtected && (
                        <Badge variant="outline">{t("protected")}</Badge>
                      )}
                      {elsewhere && (
                        <Badge
                          title={branch.checkedOutPath ?? undefined}
                          variant="outline"
                        >
                          {t("otherWorktree")}
                        </Badge>
                      )}
                      {kind === "remote" && branch.local && (
                        <Badge variant="outline">{t("localAvailable")}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {kind === "local" ? (
                        <>
                          {dirty && !branch.current ? (
                            <ConfirmationDialog
                              actionLabel={t("stashAndSwitch")}
                              cancelLabel={t("cancel")}
                              description={t("confirmDirtySwitchDescription", {
                                branch: branch.name,
                              })}
                              onConfirm={() =>
                                onOperation("SWITCH_BRANCH", {
                                  branch: branch.name,
                                  stashChanges: true,
                                })
                              }
                              title={t("confirmDirtySwitchTitle")}
                              trigger={
                                <Button
                                  aria-label={`${t("switch")} ${branch.name}`}
                                  disabled={
                                    busy ||
                                    !canOperate ||
                                    branch.current ||
                                    elsewhere
                                  }
                                  size="sm"
                                  variant="outline"
                                >
                                  <GitBranch /> {t("switch")}
                                </Button>
                              }
                            />
                          ) : (
                            <Button
                              aria-label={`${t("switch")} ${branch.name}`}
                              disabled={
                                busy ||
                                !canOperate ||
                                branch.current ||
                                elsewhere
                              }
                              onClick={() =>
                                void onOperation("SWITCH_BRANCH", {
                                  branch: branch.name,
                                  stashChanges: false,
                                })
                              }
                              size="sm"
                              variant="outline"
                            >
                              <GitBranch /> {t("switch")}
                            </Button>
                          )}
                          <ConfirmationDialog
                            actionLabel={t("delete")}
                            cancelLabel={t("cancel")}
                            description={t("confirmDeleteBranchDescription", {
                              branch: branch.name,
                            })}
                            onConfirm={() =>
                              onOperation("DELETE_BRANCH", {
                                branch: branch.name,
                              })
                            }
                            title={t("confirmDeleteBranchTitle")}
                            trigger={
                              <Button
                                aria-label={`${t("delete")} ${branch.name}`}
                                disabled={
                                  busy ||
                                  !canOperate ||
                                  branch.current ||
                                  defaultBranchProtected ||
                                  elsewhere
                                }
                                size="sm"
                                variant="destructive"
                              >
                                <Trash2 /> {t("delete")}
                              </Button>
                            }
                          />
                        </>
                      ) : (
                        <>
                          {dirty && !branch.current ? (
                            <ConfirmationDialog
                              actionLabel={t("stashAndCheckout")}
                              cancelLabel={t("cancel")}
                              description={t(
                                "confirmDirtyCheckoutDescription",
                                { branch: branch.name },
                              )}
                              onConfirm={() =>
                                onOperation("SWITCH_BRANCH", {
                                  branch: branch.name,
                                  stashChanges: true,
                                })
                              }
                              title={t("confirmDirtyCheckoutTitle")}
                              trigger={
                                <Button
                                  aria-label={`${t("checkout")} ${branch.name}`}
                                  disabled={
                                    busy ||
                                    !canOperate ||
                                    branch.current ||
                                    elsewhere
                                  }
                                  size="sm"
                                  variant="outline"
                                >
                                  <GitBranch /> {t("checkout")}
                                </Button>
                              }
                            />
                          ) : (
                            <Button
                              aria-label={`${t("checkout")} ${branch.name}`}
                              disabled={
                                busy ||
                                !canOperate ||
                                branch.current ||
                                elsewhere
                              }
                              onClick={() =>
                                void onOperation("SWITCH_BRANCH", {
                                  branch: branch.name,
                                  stashChanges: false,
                                })
                              }
                              size="sm"
                              variant="outline"
                            >
                              <GitBranch /> {t("checkout")}
                            </Button>
                          )}
                          <Button
                            aria-label={`${t("pull")} ${branch.name}`}
                            disabled={
                              busy ||
                              !canOperate ||
                              !branch.local ||
                              elsewhere ||
                              (branch.current && dirty)
                            }
                            onClick={() =>
                              void onOperation("PULL_BRANCH", {
                                branch: branch.name,
                              })
                            }
                            size="sm"
                            variant="outline"
                          >
                            <Download /> {t("pull")}
                          </Button>
                          <ConfirmationDialog
                            actionLabel={t("deleteRemote")}
                            cancelLabel={t("cancel")}
                            description={t(
                              "confirmDeleteRemoteBranchDescription",
                              { branch: branch.name },
                            )}
                            onConfirm={() =>
                              onOperation("DELETE_REMOTE_BRANCH", {
                                branch: branch.name,
                              })
                            }
                            title={t("confirmDeleteRemoteBranchTitle")}
                            trigger={
                              <Button
                                aria-label={`${t("deleteRemote")} ${branch.name}`}
                                disabled={
                                  busy ||
                                  !canOperate ||
                                  defaultBranchProtected ||
                                  remoteMainProtected
                                }
                                size="sm"
                                variant="destructive"
                              >
                                <Trash2 /> {t("deleteRemote")}
                              </Button>
                            }
                          />
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function StashTable({
  stashes,
  truncated,
  busy,
  canOperate,
  diffs,
  onToggleDiff,
  onOperation,
}: {
  stashes: CodebaseStash[];
  truncated: boolean;
  busy: boolean;
  canOperate: boolean;
  diffs: Record<string, DiffEntry>;
  onToggleDiff: (stash: CodebaseStash) => Promise<void>;
  onOperation: (
    operation: CodebaseGitOperation,
    values: { stashOid?: string },
  ) => Promise<void>;
}) {
  const t = useTranslations("codebaseDetail");
  const [copyStates, setCopyStates] = useState<Record<string, CopyState>>({});
  const [query, setQuery] = useState("");
  const title = t("stashesTitle");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return stashes;
    return stashes.filter((stash) =>
      `${stash.message} ${stash.selector} ${stash.oid}`
        .toLowerCase()
        .includes(needle),
    );
  }, [stashes, query]);

  const copyPatch = async (stashOid: string, patch: string) => {
    try {
      await copyText(patch);
      setCopyStates((current) => ({ ...current, [stashOid]: "COPIED" }));
    } catch {
      setCopyStates((current) => ({ ...current, [stashOid]: "FAILED" }));
    }
  };

  if (stashes.length === 0) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ArchiveRestore />
            </EmptyMedia>
            <EmptyTitle>{t("noStashes")}</EmptyTitle>
            <EmptyDescription>{t("noStashesDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="gap-0 py-0">
        <TableToolbar title={title}>
          <TableSearch
            label={t("searchStashes")}
            onChange={setQuery}
            placeholder={t("searchStashesPlaceholder")}
            value={query}
          />
        </TableToolbar>
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("noMatchingStashes")}
          </p>
        ) : (
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("stashMessage")}</TableHead>
                <TableHead className="text-right">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((stash) => {
                const entry = diffs[stash.oid];
                const copyState = copyStates[stash.oid] ?? "IDLE";
                return (
                  // The patch preview needs the full table width, so it rides
                  // in a second row keyed alongside the stash's own.
                  <Fragment key={stash.oid}>
                    <TableRow>
                      <TableCell className="max-w-md align-top break-words whitespace-normal">
                        {stash.message}
                        <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                          {stash.selector} · {stash.oid.slice(0, 10)} ·{" "}
                          <DateTime value={stash.createdAt} />
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            aria-label={`${t("preview")} ${stash.selector}`}
                            disabled={busy}
                            onClick={() => void onToggleDiff(stash)}
                            size="sm"
                            variant="outline"
                          >
                            {entry?.loading ? (
                              <Spinner />
                            ) : entry?.open ? (
                              <ChevronUp />
                            ) : (
                              <ChevronDown />
                            )}
                            {entry?.open ? t("hidePreview") : t("preview")}
                          </Button>
                          <Button
                            aria-label={`${t("apply")} ${stash.selector}`}
                            disabled={busy || !canOperate}
                            onClick={() =>
                              void onOperation("APPLY_STASH", {
                                stashOid: stash.oid,
                              })
                            }
                            size="sm"
                            variant="outline"
                          >
                            <ArchiveRestore /> {t("apply")}
                          </Button>
                          <ConfirmationDialog
                            actionLabel={t("delete")}
                            cancelLabel={t("cancel")}
                            description={t("confirmDeleteStashDescription", {
                              stash: stash.selector,
                            })}
                            onConfirm={() =>
                              onOperation("DELETE_STASH", {
                                stashOid: stash.oid,
                              })
                            }
                            title={t("confirmDeleteStashTitle")}
                            trigger={
                              <Button
                                aria-label={`${t("delete")} ${stash.selector}`}
                                disabled={busy || !canOperate}
                                size="sm"
                                variant="destructive"
                              >
                                <Trash2 /> {t("delete")}
                              </Button>
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                    {entry?.open && (
                      <TableRow className="hover:bg-transparent">
                        {/* `max-w-0` keeps a wide patch from stretching the
                            table, so the patch scrolls instead of the card. */}
                        <TableCell className="max-w-0" colSpan={2}>
                          <div className="space-y-2">
                            {entry.error ? (
                              <Alert variant="destructive">
                                <AlertDescription>
                                  {entry.error}
                                </AlertDescription>
                              </Alert>
                            ) : entry.loading ? (
                              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner /> {t("loadingPreview")}
                              </p>
                            ) : (
                              <>
                                {entry.diff?.patch && (
                                  <div className="flex justify-end">
                                    <Button
                                      aria-label={`${
                                        copyState === "COPIED"
                                          ? t("patchCopied")
                                          : t("copyPatch")
                                      } ${stash.selector}`}
                                      onClick={() =>
                                        void copyPatch(
                                          stash.oid,
                                          entry.diff?.patch ?? "",
                                        )
                                      }
                                      size="sm"
                                      type="button"
                                      variant="outline"
                                    >
                                      {copyState === "COPIED" ? (
                                        <Check />
                                      ) : (
                                        <Copy />
                                      )}
                                      {copyState === "COPIED"
                                        ? t("patchCopied")
                                        : t("copyPatch")}
                                    </Button>
                                  </div>
                                )}
                                {copyState === "FAILED" && (
                                  <p className="text-xs text-destructive">
                                    {t("copyPatchFailed")}
                                  </p>
                                )}
                                {entry.diff?.patch ? (
                                  <PatchView
                                    className="max-h-[32rem]"
                                    patch={entry.diff.patch}
                                    truncated={entry.diff.truncated}
                                    truncatedLabel={t("patchTruncated")}
                                  />
                                ) : (
                                  <p className="text-sm text-muted-foreground">
                                    {t("emptyPatch")}
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      {truncated && (
        <p className="text-xs text-muted-foreground">{t("stashesTruncated")}</p>
      )}
    </div>
  );
}

function Info({
  label,
  value,
  mono = false,
  small = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  /** Match the mono rows' size without switching the typeface. */
  small?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "truncate",
          (mono || small) && "text-xs",
          mono && "font-mono",
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
