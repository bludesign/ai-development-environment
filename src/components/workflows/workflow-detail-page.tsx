"use client";

import {
  ChevronDown,
  CircleOff,
  CirclePause,
  CirclePlay,
  Download,
  Pencil,
  RefreshCw,
  Save,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link, useRouter } from "@/i18n/navigation";
import { downloadJson, exportFileStem } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";
import { loadWorkflowCatalog } from "./workflow-catalog";
import { WorkflowChoiceMenu } from "./workflow-choice-menu";
import { WorkflowGraph, workflowStatusVariant } from "./workflow-graph";
import { WorkflowReadonlyInspector } from "./workflow-readonly-inspector";
import { WorktreeRunQueueCard } from "./worktree-run-queue-card";
import {
  BUILD_CONFIGURATION_ICON_KEYS,
  ConfigurationIcon,
} from "@/components/builds/configuration-icon";
import { useWorkflowLabels } from "./workflow-labels";
import type {
  WorkflowDefinition,
  WorkflowCatalog,
  WorkflowRun,
  WorkflowSummary,
  WorkflowVersion,
  WorktreeRunQueueEntry,
} from "./types";

type WorkflowDetail = WorkflowSummary & {
  activeVersion: WorkflowVersion | null;
  versions: WorkflowVersion[];
};

const DETAIL_FIELDS = `
  id name description draftDefinition activeVersionId enabled overlapPolicy overlapScope maxConcurrentRuns completionNotificationsEnabled exclusiveWorktree worktreeConcurrency blocksGitOperations archivedAt quickActionKind quickActionIconKey quickActionButtonVariant
  hasPlainTrigger
  triggerChoices { key label description }
  quickActionRepositories { id name displayOrigin }
  versionCount runCount createdAt updatedAt
  activeVersion { id workflowId version name description schemaVersion definition contentHash publishedAt }
  versions { id version contentHash publishedAt }
`;

const RUN_FIELDS = `
  id displayNumber workflowId triggerKind triggerSubjectKey status phase worktreeConcurrency blocksGitOperations generation
  blockedReason error queuedAt startedAt pausedAt finishedAt
  workflow { id name }
`;

export function WorkflowDetailPage({ workflowId }: { workflowId: string }) {
  const t = useTranslations("workflows");
  const buildsT = useTranslations("builds");
  const labels = useWorkflowLabels();
  const router = useRouter();
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [queue, setQueue] = useState<WorktreeRunQueueEntry[]>([]);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<
    Array<{ id: string; name: string; displayOrigin: string }>
  >([]);
  const [quickActionKind, setQuickActionKind] = useState<
    "STANDARD" | "MERGE_CONFLICT" | "GITHUB_ACTIONS" | "NONE"
  >("NONE");
  const [quickActionIconKey, setQuickActionIconKey] = useState("play");
  const [quickActionButtonVariant, setQuickActionButtonVariant] = useState<
    "default" | "outline" | "secondary" | "destructive"
  >("default");
  const [quickActionRepositoryIds, setQuickActionRepositoryIds] = useState<
    string[]
  >([]);
  const [savingQuickAction, setSavingQuickAction] = useState(false);

  useEffect(() => {
    if (!selectedNodeId) return;
    const controller = new AbortController();
    void loadWorkflowCatalog(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((value: unknown) => {
        if (!controller.signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      });
    return () => controller.abort();
  }, [selectedNodeId]);

  const notFoundMessage = t("notFound");
  const ownerRef = useRef<RefreshCoalescer | null>(null);
  const definitionRevision = useRef(0);
  const definitionsLoaded = useRef(-1);
  const repositoriesRevision = useRef(0);
  const repositoriesLoaded = useRef(-1);
  const appliedDraft = useRef("");
  const load = useCallback(() => {
    ++definitionRevision.current;
    ++repositoriesRevision.current;
    return ownerRef.current?.refresh() ?? Promise.resolve();
  }, []);
  const fetchOverview = useCallback(
    async (signal: AbortSignal) => {
      const definitionsVersion = definitionRevision.current;
      const repositoriesVersion = repositoriesRevision.current;
      const includeDefinition =
        definitionsVersion !== definitionsLoaded.current;
      const includeRepositories =
        repositoriesVersion !== repositoriesLoaded.current;
      try {
        const data = await controlPlaneRequest<{
          workflow?: WorkflowDetail | null;
          workflowRuns: { items: WorkflowRun[]; totalCount: number };
          worktreeRunQueue: WorktreeRunQueueEntry[];
          codebaseOverview?: {
            repositories: Array<{
              id: string;
              name: string;
              displayOrigin: string;
            }>;
          };
        }>(
          `query WorkflowOverview($id: ID!, $includeDefinition: Boolean!, $includeRepositories: Boolean!) {
        workflow(id: $id) @include(if: $includeDefinition) { ${DETAIL_FIELDS} }
        workflowRuns(workflowId: $id, first: 100) { totalCount items { ${RUN_FIELDS} } }
        worktreeRunQueue(workflowId: $id) {
          position id kind displayNumber name status phase worktreeId workflowId workflowRunId
          queuedAt exclusiveWorktree worktreeConcurrency worktreeConcurrencyLimit
          worktree { id folder branch highlightColor }
        }
        codebaseOverview @include(if: $includeRepositories) { repositories { id name displayOrigin } }
      }`,
          { id: workflowId, includeDefinition, includeRepositories },
          { signal },
        );
        if (signal.aborted) return;
        if (includeDefinition) {
          setWorkflow(data.workflow ?? null);
          definitionsLoaded.current = definitionsVersion;
        } else if (data.workflowRuns.totalCount !== undefined) {
          setWorkflow((current) =>
            current
              ? { ...current, runCount: data.workflowRuns.totalCount }
              : current,
          );
        }
        setRuns(data.workflowRuns.items);
        setQueue(data.worktreeRunQueue ?? []);
        if (includeRepositories) {
          setRepositories(data.codebaseOverview?.repositories ?? []);
          repositoriesLoaded.current = repositoriesVersion;
        }
        const version = JSON.stringify([
          data.workflow?.id,
          data.workflow?.updatedAt,
        ]);
        if (
          includeDefinition &&
          data.workflow &&
          appliedDraft.current !== version
        ) {
          appliedDraft.current = version;
          setQuickActionKind(data.workflow.quickActionKind ?? "NONE");
          setQuickActionIconKey(data.workflow.quickActionIconKey ?? "play");
          setQuickActionButtonVariant(
            data.workflow.quickActionButtonVariant ?? "default",
          );
          setQuickActionRepositoryIds(
            data.workflow.quickActionRepositories?.map(({ id }) => id) ?? [],
          );
        }
        if (includeDefinition) setError(data.workflow ? null : notFoundMessage);
      } catch (value) {
        if (signal.aborted) return;
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [notFoundMessage, workflowId],
  );

  useEffect(() => {
    definitionsLoaded.current = -1;
    repositoriesLoaded.current = -1;
    const owner = createRefreshCoalescer(fetchOverview);
    ownerRef.current = owner;
    const refresh = () => {
      void owner.refresh().catch(() => undefined);
    };
    const timer = window.setTimeout(refresh, 0);
    const client = controlPlaneSubscriptions();
    const workflowSubscription = client.subscribe<{
      workflowChanges: { definitionsChanged: boolean };
    }>(
      {
        query:
          "subscription WorkflowOverviewChanged($workflowId: ID!) { workflowChanges(workflowId: $workflowId, includeQueuePeers: true) { definitionsChanged } }",
        variables: { workflowId },
      },
      {
        next: ({ data }) => {
          if (data?.workflowChanges.definitionsChanged)
            ++definitionRevision.current;
          refresh();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const agentRunSubscription = client.subscribe(
      {
        query:
          "subscription WorkflowQueueAgentRuns($workflowId: ID!) { agentRunListChanged(workflowId: $workflowId) }",
        variables: { workflowId },
      },
      { next: refresh, error: () => undefined, complete: () => undefined },
    );
    const repositoriesSubscription = client.subscribe(
      {
        query:
          "subscription WorkflowRepositoryChoices { codebaseOverviewChanged { repositoryId } }",
      },
      {
        next: () => {
          ++repositoriesRevision.current;
          refresh();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const recovery = onControlPlaneRecovery(() => {
      ++definitionRevision.current;
      ++repositoriesRevision.current;
      refresh();
    });
    return () => {
      window.clearTimeout(timer);
      workflowSubscription();
      agentRunSubscription();
      repositoriesSubscription();
      recovery();
      owner.dispose();
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [fetchOverview, workflowId]);

  const toggleEnabled = async () => {
    if (!workflow) return;
    try {
      await controlPlaneRequest(
        `mutation ToggleWorkflow($id: ID!, $enabled: Boolean!) { setWorkflowEnabled(id: $id, enabled: $enabled) { id } }`,
        { id: workflow.id, enabled: !workflow.enabled },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const trigger = async (choice: string | null) => {
    if (!workflow) return;
    try {
      const data = await controlPlaneRequest<{
        triggerWorkflow: { id: string };
      }>(
        `mutation RunWorkflow($input: TriggerWorkflowInput!) { triggerWorkflow(input: $input) { id } }`,
        { input: { workflowId: workflow.id, sessionData: {}, choice } },
      );
      router.push(`/workflows/runs/${data.triggerWorkflow.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const saveQuickAction = async () => {
    if (!workflow) return;
    setSavingQuickAction(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation SetWorkflowQuickAction($input: SetWorkflowQuickActionInput!) {
          setWorkflowQuickAction(input: $input) { id }
        }`,
        {
          input: {
            id: workflow.id,
            kind: quickActionKind,
            quickActionIconKey,
            quickActionButtonVariant,
            repositoryIds: quickActionRepositoryIds,
          },
        },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSavingQuickAction(false);
    }
  };

  const exportWorkflow = async (versionId?: string) => {
    if (!workflow) return;
    try {
      const data = await controlPlaneRequest<{ exportWorkflow: unknown }>(
        `query ExportWorkflow($id: ID!, $versionId: ID) { exportWorkflow(id: $id, versionId: $versionId) }`,
        { id: workflow.id, versionId: versionId ?? null },
      );
      downloadJson(
        data.exportWorkflow,
        `${exportFileStem(workflow.name)}.workflow.json`,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  if (loading)
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton className="h-32" key={item} />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  if (!workflow)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  const shownDefinition: WorkflowDefinition =
    workflow.activeVersion?.definition ?? workflow.draftDefinition;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {workflow.name}
              </h1>
              <Badge variant={workflow.enabled ? "secondary" : "outline"}>
                {workflow.enabled ? t("enabled") : t("disabled")}
              </Badge>
              {workflow.activeVersion && (
                <Badge variant="outline">
                  v{workflow.activeVersion.version}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {workflow.description || t("noDescription")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => void load()}
                size="icon"
                variant="outline"
                aria-label={t("refresh")}
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("refresh")}</TooltipContent>
          </Tooltip>
          <Button onClick={() => void exportWorkflow()} variant="outline">
            <Download /> {t("export")}
          </Button>
          <Button asChild variant="outline">
            <Link href={`/workflows/${workflow.id}/edit`}>
              <Pencil /> {t("edit")}
            </Link>
          </Button>
          <Button onClick={() => void toggleEnabled()} variant="outline">
            {workflow.enabled ? <CirclePause /> : <CirclePlay />}{" "}
            {workflow.enabled ? t("pauseDefinition") : t("enable")}
          </Button>
          <WorkflowChoiceMenu
            button={
              <Button disabled={!workflow.enabled}>
                <CirclePlay /> {t("run")}
              </Button>
            }
            choices={workflow.triggerChoices}
            hasPlainTrigger={workflow.hasPlainTrigger}
            onRun={(choice) => void trigger(choice)}
          />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("publishedVersion")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {workflow.activeVersion
              ? `v${workflow.activeVersion.version}`
              : "—"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("runs")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {workflow.runCount}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("overlapPolicy")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {labels.overlapPolicy(workflow.overlapPolicy)}
            </Badge>
            <Badge variant="outline">
              {labels.overlapScope(workflow.overlapScope)}
            </Badge>
            {workflow.overlapPolicy === "CONCURRENT" && (
              <Badge variant="outline">
                {`${t("maxConcurrentRuns")}: ${workflow.maxConcurrentRuns}`}
              </Badge>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("worktreeConcurrency")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">
              {labels.worktreeConcurrency(workflow.worktreeConcurrency)}
            </Badge>
            {workflow.blocksGitOperations && (
              <Badge variant="outline">{t("blocksGitOperationsBadge")}</Badge>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("graph")}</CardTitle>
        </CardHeader>
        <CardContent>
          <WorkflowGraph
            definition={shownDefinition}
            onNodeClick={(nodeId) => setSelectedNodeId(nodeId)}
            selectedNodeId={selectedNodeId}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("quickActions")}</CardTitle>
          <CardDescription>{t("quickActionsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="workflow-quick-action-icon">
                {t("quickActionIcon")}
              </Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={`${t("quickActionIcon")}: ${buildsT(`configurationIcons.${quickActionIconKey}`)}`}
                    className="w-full justify-between sm:w-64"
                    id="workflow-quick-action-icon"
                    type="button"
                    variant="outline"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {quickActionIconKey === "none" ? (
                        <CircleOff className="size-4 shrink-0" />
                      ) : (
                        <ConfigurationIcon iconKey={quickActionIconKey} />
                      )}
                      <span className="truncate">
                        {buildsT(
                          `configurationIcons.${quickActionIconKey}` as never,
                        )}
                      </span>
                    </span>
                    <ChevronDown className="text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-64">
                  <DropdownMenuRadioGroup
                    onValueChange={setQuickActionIconKey}
                    value={quickActionIconKey}
                  >
                    {["none", ...BUILD_CONFIGURATION_ICON_KEYS].map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {value === "none" ? (
                          <CircleOff className="size-4" />
                        ) : (
                          <ConfigurationIcon iconKey={value} />
                        )}
                        {buildsT(`configurationIcons.${value}` as never)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="space-y-2">
              <Label htmlFor="workflow-quick-action-style">
                {t("quickActionStyle")}
              </Label>
              <Select
                onValueChange={(value) =>
                  setQuickActionButtonVariant(
                    value as typeof quickActionButtonVariant,
                  )
                }
                value={quickActionButtonVariant}
              >
                <SelectTrigger
                  className="w-full sm:w-64"
                  id="workflow-quick-action-style"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["default", "outline", "secondary", "destructive"].map(
                    (variant) => (
                      <SelectItem key={variant} value={variant}>
                        {t(`quickActionStyles.${variant}` as never)}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="workflow-quick-action-kind">
              {t("quickActionKind")}
            </Label>
            <Select
              onValueChange={(value) =>
                setQuickActionKind(value as typeof quickActionKind)
              }
              value={quickActionKind}
            >
              <SelectTrigger
                className="w-full sm:w-72"
                id="workflow-quick-action-kind"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["STANDARD", "MERGE_CONFLICT", "GITHUB_ACTIONS", "NONE"].map(
                  (kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`quickActionKinds.${kind}` as never)}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(`quickActionKindHelp.${quickActionKind}` as never)}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t("repositoryQuickActions")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("repositoryQuickActionsHelp")}
            </p>
            <div className="max-h-56 space-y-1 overflow-auto rounded-lg border p-2">
              {repositories.map((repository) => (
                <label
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                  key={repository.id}
                >
                  <Checkbox
                    checked={quickActionRepositoryIds.includes(repository.id)}
                    className="mt-0.5"
                    onCheckedChange={(checked) =>
                      setQuickActionRepositoryIds((current) =>
                        checked === true
                          ? [...new Set([...current, repository.id])]
                          : current.filter((id) => id !== repository.id),
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {repository.name}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {repository.displayOrigin}
                    </span>
                  </span>
                </label>
              ))}
              {!repositories.length && (
                <p className="px-2 py-1 text-sm text-muted-foreground">
                  {t("noQuickActionRepositories")}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {t("quickActionEligibility")}
            </p>
            <Button
              disabled={savingQuickAction}
              onClick={() => void saveQuickAction()}
            >
              {savingQuickAction ? <Spinner /> : <Save />}
              {t("saveQuickActions")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <WorktreeRunQueueCard entries={queue} scope="WORKFLOW" />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("recentRuns")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("run")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead>{t("trigger")}</TableHead>
                    <TableHead>{t("started")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.slice(0, 20).map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <Link
                          className="font-medium hover:underline"
                          href={`/workflows/runs/${run.id}`}
                        >
                          #{run.displayNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={workflowStatusVariant(run.status)}>
                          {labels.status(run.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>{labels.kind(run.triggerKind)}</TableCell>
                      <TableCell>
                        {run.startedAt ? (
                          <DateTime kind="relative" value={run.startedAt} />
                        ) : (
                          t("queued")
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!runs.length && (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyTitle>{t("noRuns")}</EmptyTitle>
                    <EmptyDescription>{t("recentRuns")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("versionHistory")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("version")}</TableHead>
                    <TableHead>{t("hash")}</TableHead>
                    <TableHead>{t("publishedAt")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workflow.versions.map((version) => (
                    <TableRow key={version.id}>
                      <TableCell>v{version.version}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {version.contentHash.slice(0, 12)}
                      </TableCell>
                      <TableCell>
                        <DateTime kind="relative" value={version.publishedAt} />
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              aria-label={t("exportVersion", {
                                version: version.version,
                              })}
                              onClick={() => void exportWorkflow(version.id)}
                              size="icon"
                              variant="ghost"
                            >
                              <Download />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("exportVersion", { version: version.version })}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!workflow.versions.length && (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyTitle>{t("unpublished")}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <WorkflowReadonlyInspector
        catalog={catalog}
        definition={shownDefinition}
        onOpenChange={(open) => {
          if (!open) setSelectedNodeId(null);
        }}
        selectedId={selectedNodeId}
      />
    </div>
  );
}
