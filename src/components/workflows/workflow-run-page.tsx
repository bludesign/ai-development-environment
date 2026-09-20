"use client";

import {
  CirclePause,
  CirclePlay,
  CircleStop,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";
import { workflowRunNodeDestinations } from "@/lib/workflows/resource-navigation";
import { workflowResourceDestination } from "@/lib/workflows/resources";

import { useOpenWorkflowDestination } from "./use-workflow-destination";
import { WorkflowGraph, workflowStatusVariant } from "./workflow-graph";
import { useWorkflowLabels } from "./workflow-labels";
import { WorkflowWaitCard } from "./workflow-wait-card";
import { WorktreeRunQueueCard } from "./worktree-run-queue-card";
import {
  WORKFLOW_REUSED_PHASE,
  type WorkflowRun,
  type WorktreeRunQueueEntry,
} from "./types";

import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

const EVENT_FIELDS = `id attemptId sequence type message detail createdAt`;
const RUN_DETAIL_FIELDS = `
  id displayNumber workflowId versionId triggerKind triggerSubjectKey status phase worktreeConcurrency blocksGitOperations generation
  sessionData sessionRevision blockedReason error queuedAt startedAt pausedAt finishedAt createdAt updatedAt
  workflow { id name }
  worktree { id folder branch highlightColor }
  queue {
    position id kind displayNumber name status phase worktreeId workflowId workflowRunId
    queuedAt exclusiveWorktree worktreeConcurrency worktreeConcurrencyLimit
    worktree { id folder branch highlightColor }
  }
  trigger { nodeId }
  version { id workflowId version name description schemaVersion definition contentHash publishedAt }
  attempts {
    id nodeId kind generation iterationKey attempt status phase input output error requiredPaths providedPaths
    resourceLockKey idempotencyKey startedAt finishedAt supersededAt replayedFromId createdAt updatedAt
    resourceLinks { id attemptId kind resourceId label url metadata createdAt }
    questionBatches {
      id nativeRequestId eventSequence status createdAt answeredAt supersededAt revisionPreparedAt rollbackPatch pushedCommitWarning
      questions { id position header prompt multiSelect allowCustom options { id position label description } }
      answerRevisions { id revision answers createdAt supersededAt replacementAttemptId }
      checkpoint { id kind headSha branch upstreamSha refName diffSummary stashRef createdAt }
    }
    checkpoints { id kind headSha branch upstreamSha refName diffSummary stashRef createdAt }
  }
  waits { id attemptId kind status predicate externalKey resumeAfter timeoutAt result createdAt resolvedAt updatedAt }
  resourceLinks { id attemptId kind resourceId label url metadata createdAt }
`;

type ReplayPreview = {
  runId: string;
  nodeId: string;
  affectedNodeIds: string[];
  affectedAttemptIds: string[];
  externalEffects: Array<{
    kind: string;
    resourceId: string;
    label: string | null;
    url: string | null;
  }>;
  checkpointId: string | null;
  gitComparison: Record<string, unknown> | null;
  warning: string | null;
};

type WorkflowRunDetail = WorkflowRun & {
  queue?: WorktreeRunQueueEntry[];
};

export type WorkflowQuestion = {
  id: string;
  header?: string | null;
  prompt: string;
  multiSelect: boolean;
  allowCustom: boolean;
  options: Array<{
    id: string;
    label: string;
    description?: string | null;
  }>;
};

export function workflowQuestionAnswerPayload(
  questions: WorkflowQuestion[],
  answers: Record<string, string[]>,
  customAnswers: Record<string, string>,
) {
  return Object.fromEntries(
    questions.map((question) => {
      const selected = [...(answers[question.id] ?? [])];
      const custom = customAnswers[question.id]?.trim();
      if (custom) selected.push(custom);
      return [question.id, { answers: selected }];
    }),
  );
}

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function triggerSubjectLabel(run: WorkflowRun): string {
  if (run.worktree && run.triggerSubjectKey === `WORKTREE:${run.worktree.id}`) {
    return run.worktree.branch ?? run.worktree.folder;
  }
  return run.triggerSubjectKey;
}

export function WorkflowRunPage({ runId }: { runId: string }) {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
  const common = useTranslations("common");
  const openDestination = useOpenWorkflowDestination();
  const [run, setRun] = useState<WorkflowRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repairText, setRepairText] = useState("{}");
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(
    {},
  );
  const [replayNodeId, setReplayNodeId] = useState<string>("");
  const [preview, setPreview] = useState<ReplayPreview | null>(null);
  const [events, setEvents] = useState<WorkflowRun["events"]>([]);
  const [hasOlderEvents, setHasOlderEvents] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const eventsRef = useRef<WorkflowRun["events"]>([]);
  const ownerRef = useRef<ReturnType<typeof createRefreshCoalescer> | null>(
    null,
  );
  const olderRequest = useRef<AbortController | null>(null);
  const eventCursor = useRef<number | null>(null);
  const stateRevision = useRef(0);
  const mergeEvents = useCallback((incoming: WorkflowRun["events"]) => {
    const merged = new Map(eventsRef.current.map((event) => [event.id, event]));
    for (const event of incoming) merged.set(event.id, event);
    eventsRef.current = [...merged.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    setEvents(eventsRef.current);
  }, []);
  const nodeDestinations = useMemo(
    () => (run ? workflowRunNodeDestinations(run) : new Map()),
    [run],
  );
  // A step parks at most one wait at a time, so the attempt id identifies it.
  const pendingWaits = useMemo(
    () =>
      new Map(
        (run?.waits ?? [])
          .filter(({ status }) => status === "PENDING")
          .map((wait) => [wait.attemptId, wait]),
      ),
    [run],
  );

  const notFoundMessage = t("runNotFound");
  const load = useCallback(async () => {
    await ownerRef.current?.refresh();
  }, []);
  const loadOlderEvents = useCallback(async () => {
    if (olderRequest.current || !eventsRef.current.length) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    try {
      const data = await controlPlaneRequest<{
        workflowRunEvents: WorkflowRun["events"];
      }>(
        `query OlderWorkflowRunEvents($id: ID!, $before: Int!) {
          workflowRunEvents(runId: $id, beforeSequence: $before, first: 100) { ${EVENT_FIELDS} }
        }`,
        { id: runId, before: eventsRef.current[0]!.sequence },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      mergeEvents(data.workflowRunEvents);
      setHasOlderEvents(
        Boolean(
          data.workflowRunEvents.length &&
          data.workflowRunEvents[0]!.sequence > 0,
        ),
      );
    } catch (value) {
      if (!controller.signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }, [mergeEvents, runId]);

  useEffect(() => {
    eventsRef.current = [];
    eventCursor.current = null;
    const owner = createRefreshCoalescer(async (signal) => {
      const revision = stateRevision.current;
      const initial = eventCursor.current === null;
      try {
        const data = await controlPlaneRequest<{
          workflowRun: WorkflowRunDetail | null;
          workflowRunEvents: WorkflowRun["events"];
        }>(
          `query WorkflowRunDetail($id: ID!, $after: Int!, $latest: Boolean!, $first: Int!) {
          workflowRun(id: $id) { ${RUN_DETAIL_FIELDS} }
          workflowRunEvents(runId: $id, afterSequence: $after, latest: $latest, first: $first) { ${EVENT_FIELDS} }
        }`,
          {
            id: runId,
            after: eventCursor.current ?? -1,
            latest: initial,
            first: initial ? 100 : 1000,
          },
          { signal },
        );
        if (signal.aborted) return;
        if (revision === stateRevision.current) setRun(data.workflowRun);
        let page = data.workflowRunEvents;
        mergeEvents(page);
        if (initial)
          setHasOlderEvents(Boolean(page.length && page[0]!.sequence > 0));
        eventCursor.current =
          page.at(-1)?.sequence ?? eventCursor.current ?? -1;
        // Events allocate their sequence in a DB transaction. Advance recovery
        // only through HTTP snapshots, never through a possibly gapped live stream.
        while (!initial && page.length === 1000) {
          const before: number = eventCursor.current ?? -1;
          const next = await controlPlaneRequest<{
            workflowRunEvents: WorkflowRun["events"];
          }>(
            `query WorkflowRunEventRecovery($id: ID!, $after: Int!) {
              workflowRunEvents(runId: $id, afterSequence: $after, first: 1000) { ${EVENT_FIELDS} }
            }`,
            { id: runId, after: before },
            { signal },
          );
          if (signal.aborted) return;
          page = next.workflowRunEvents;
          mergeEvents(page);
          eventCursor.current = page.at(-1)?.sequence ?? before;
          if (eventCursor.current === before) break;
        }
        setError(data.workflowRun ? null : notFoundMessage);
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    ownerRef.current = owner;
    const client = controlPlaneSubscriptions();
    const subscriptions = [
      client.subscribe<{ workflowRunChanged: WorkflowRunDetail }>(
        {
          query: `subscription WorkflowRunState($id: ID!) { workflowRunChanged(runId: $id) { ${RUN_DETAIL_FIELDS} } }`,
          variables: { id: runId },
        },
        {
          next: (result) => {
            const value = result.data?.workflowRunChanged;
            if (value) {
              ++stateRevision.current;
              setRun(value);
              setLoading(false);
            }
          },
          error: () => undefined,
          complete: () => undefined,
        },
      ),
      client.subscribe<{
        workflowRunEventAdded: WorkflowRun["events"][number];
      }>(
        {
          query: `subscription WorkflowRunEvents($id: ID!) { workflowRunEventAdded(runId: $id) { ${EVENT_FIELDS} } }`,
          variables: { id: runId },
        },
        {
          next: (result) => {
            if (result.data?.workflowRunEventAdded)
              mergeEvents([result.data.workflowRunEventAdded]);
          },
          error: () => undefined,
          complete: () => undefined,
        },
      ),
      onControlPlaneRecovery(() => void owner.refresh()),
    ];
    const recover = () => {
      if (document.visibilityState !== "hidden") void owner.refresh();
    };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    const timer = window.setTimeout(() => void owner.refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      subscriptions.forEach((dispose) => dispose());
      owner.dispose();
      olderRequest.current?.abort();
      olderRequest.current = null;
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [mergeEvents, notFoundMessage, runId]);

  useEffect(() => {
    if (run?.status !== "QUEUED") return;
    const client = controlPlaneSubscriptions();
    const subscriptions = [
      client.subscribe<{ workflowChanges: { runId: string | null } }>(
        {
          query:
            "subscription QueuedWorkflowRunQueueChanges($workflowId: ID!) { workflowChanges(workflowId: $workflowId, includeQueuePeers: true) { runId } }",
          variables: { workflowId: run.workflowId },
        },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
      client.subscribe<{ agentRunListChanged: boolean }>(
        {
          query:
            "subscription QueuedWorkflowAgentRunChanges($workflowId: ID!) { agentRunListChanged(workflowId: $workflowId) }",
          variables: { workflowId: run.workflowId },
        },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    ];
    return () => subscriptions.forEach((subscription) => subscription());
  }, [load, run?.status, run?.workflowId]);

  const lifecycle = async (action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    try {
      const mutation =
        action === "pause"
          ? "pauseWorkflowRun"
          : action === "resume"
            ? "resumeWorkflowRun"
            : "cancelWorkflowRun";
      await controlPlaneRequest(
        `mutation WorkflowRunLifecycle($id: ID!) { ${mutation}(id: $id) { id status } }`,
        { id: runId },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const repair = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation RepairWorkflow($id: ID!, $patch: JSON!) { repairWorkflowRunData(id: $id, patch: $patch) { id status } }`,
        { id: runId, patch: JSON.parse(repairText) },
      );
      setRepairText("{}");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const answerQuestion = async (
    batchId: string,
    questions: WorkflowQuestion[],
  ) => {
    setBusy(true);
    try {
      const value = workflowQuestionAnswerPayload(
        questions,
        answers,
        customAnswers,
      );
      await controlPlaneRequest(
        `mutation AnswerWorkflowQuestion($batchId: ID!, $answers: JSON!) { answerWorkflowQuestion(batchId: $batchId, answers: $answers) { id status } }`,
        { batchId, answers: value },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const prepareReplay = async () => {
    if (!replayNodeId) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        prepareWorkflowReplay: ReplayPreview;
      }>(
        `query PrepareReplay($runId: ID!, $nodeId: ID!) {
          prepareWorkflowReplay(runId: $runId, nodeId: $nodeId) {
            runId nodeId affectedNodeIds affectedAttemptIds checkpointId gitComparison warning
            externalEffects { kind resourceId label url }
          }
        }`,
        { runId, nodeId: replayNodeId },
      );
      setPreview(data.prepareWorkflowReplay);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const executeReplay = async (restore: boolean, stash: boolean) => {
    if (!preview) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation ReplayWorkflow($runId: ID!, $nodeId: ID!, $restore: Boolean!, $stash: Boolean!) {
          replayWorkflowRun(runId: $runId, nodeId: $nodeId, restore: $restore, stash: $stash) { id status generation }
        }`,
        { runId, nodeId: preview.nodeId, restore, stash },
      );
      setPreview(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const pendingQuestions = useMemo(
    () =>
      run?.attempts.flatMap((attempt) =>
        (attempt.questionBatches ?? [])
          .filter((batch) => batch.status === "PENDING")
          .map((batch) => ({ attempt, batch })),
      ) ?? [],
    [run],
  );

  if (loading)
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-[min(68vh,760px)] min-h-96" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!run)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  const canPause = ["RUNNING", "WAITING", "BLOCKED"].includes(run.status);
  const canResume = run.status === "PAUSED";
  const canCancel = !["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status);
  const canReplay = [
    "PAUSED",
    "BLOCKED",
    "FAILED",
    "SUCCEEDED",
    "CANCELLED",
  ].includes(run.status);
  const highlighted = run.worktree?.highlightColor;

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-3",
          highlighted && "rounded-lg border-l-4 p-4",
          highlighted && worktreeHighlightBackgroundClasses[highlighted],
          highlighted && worktreeHighlightAccentClasses[highlighted],
        )}
      >
        <div className="flex items-start gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {run.workflow.name} #{run.displayNumber}
              </h1>
              <Badge variant={workflowStatusVariant(run.status)}>
                {labels.status(run.status)}
              </Badge>
              <Badge variant="outline">v{run.version.version}</Badge>
              <Badge variant="outline">
                {t("generationValue", { generation: run.generation })}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {labels.kind(run.triggerKind)} · {triggerSubjectLabel(run)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t("refresh")}
                onClick={() => void load()}
                size="icon"
                variant="outline"
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("refresh")}</TooltipContent>
          </Tooltip>
          {canPause && (
            <Button
              disabled={busy}
              onClick={() => void lifecycle("pause")}
              variant="outline"
            >
              <CirclePause /> {t("pause")}
            </Button>
          )}
          {canResume && (
            <Button disabled={busy} onClick={() => void lifecycle("resume")}>
              <CirclePlay /> {t("resume")}
            </Button>
          )}
          {canCancel && (
            <Button
              disabled={busy}
              onClick={() => void lifecycle("cancel")}
              variant="destructive"
            >
              <CircleStop /> {t("cancelRun")}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {(run.blockedReason || run.error) && (
        <Alert variant="destructive">
          <AlertDescription>{run.blockedReason ?? run.error}</AlertDescription>
        </Alert>
      )}

      {run.status === "QUEUED" && (
        <WorktreeRunQueueCard
          currentEntryId={run.id}
          entries={run.queue ?? []}
          scope="RUN"
        />
      )}

      <WorkflowWaitCard run={run} />

      <Card>
        <CardHeader>
          <CardTitle>{t("runGraph")}</CardTitle>
        </CardHeader>
        <CardContent>
          <WorkflowGraph
            attempts={run.attempts}
            definition={run.version.definition}
            destinations={nodeDestinations}
            generation={run.generation}
            onNodeClick={(nodeId, { destination, locked, trigger }) => {
              if (locked) {
                openDestination(destination);
                return;
              }
              if (canReplay && !trigger) setReplayNodeId(nodeId);
            }}
          />
        </CardContent>
      </Card>

      {run.status === "BLOCKED" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("repairData")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("repairDataDescription")}
            </p>
            <Textarea
              className="min-h-36 font-mono text-xs"
              onChange={(event) => setRepairText(event.target.value)}
              value={repairText}
            />
            <Button disabled={busy} onClick={() => void repair()}>
              <Wrench /> {t("applyRepair")}
            </Button>
          </CardContent>
        </Card>
      )}

      {pendingQuestions.map(({ attempt, batch }) => {
        const questions = batch.questions as WorkflowQuestion[];
        return (
          <Card key={String(batch.id)}>
            <CardHeader>
              <CardTitle>
                {t("questionFrom", { step: labels.kind(attempt.kind) })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {questions.map((question) => (
                <FieldSet key={question.id}>
                  <FieldLegend>
                    {question.header || question.prompt}
                  </FieldLegend>
                  {question.header && (
                    <FieldDescription>{question.prompt}</FieldDescription>
                  )}
                  {question.options.length > 0 && question.multiSelect && (
                    <FieldGroup data-slot="checkbox-group" className="gap-2">
                      {question.options.map((option) => {
                        const id = `answer-${question.id}-${option.id}`;
                        const checked =
                          answers[question.id]?.includes(option.label) ?? false;
                        return (
                          <FieldLabel
                            className="w-full cursor-pointer"
                            htmlFor={id}
                            key={option.id}
                          >
                            <Item size="sm" variant="outline">
                              <Checkbox
                                checked={checked}
                                id={id}
                                onCheckedChange={(next) =>
                                  setAnswers((current) => {
                                    const selected = new Set(
                                      current[question.id] ?? [],
                                    );
                                    if (next) selected.add(option.label);
                                    else selected.delete(option.label);
                                    return {
                                      ...current,
                                      [question.id]: [...selected],
                                    };
                                  })
                                }
                              />
                              <ItemContent>
                                <ItemTitle>{option.label}</ItemTitle>
                                {option.description && (
                                  <ItemDescription>
                                    {option.description}
                                  </ItemDescription>
                                )}
                              </ItemContent>
                            </Item>
                          </FieldLabel>
                        );
                      })}
                    </FieldGroup>
                  )}
                  {question.options.length > 0 && !question.multiSelect && (
                    <RadioGroup
                      onValueChange={(value) => {
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: [value],
                        }));
                        setCustomAnswers((current) => ({
                          ...current,
                          [question.id]: "",
                        }));
                      }}
                      value={answers[question.id]?.[0] ?? ""}
                    >
                      {question.options.map((option) => {
                        const id = `answer-${question.id}-${option.id}`;
                        return (
                          <FieldLabel
                            className="w-full cursor-pointer"
                            htmlFor={id}
                            key={option.id}
                          >
                            <Item size="sm" variant="outline">
                              <RadioGroupItem id={id} value={option.label} />
                              <ItemContent>
                                <ItemTitle>{option.label}</ItemTitle>
                                {option.description && (
                                  <ItemDescription>
                                    {option.description}
                                  </ItemDescription>
                                )}
                              </ItemContent>
                            </Item>
                          </FieldLabel>
                        );
                      })}
                    </RadioGroup>
                  )}
                  {question.allowCustom && (
                    <Field>
                      <FieldLabel htmlFor={`answer-${question.id}-custom`}>
                        {t("customAnswer")}
                      </FieldLabel>
                      <Textarea
                        id={`answer-${question.id}-custom`}
                        onChange={(event) => {
                          const value = event.target.value;
                          setCustomAnswers((current) => ({
                            ...current,
                            [question.id]: value,
                          }));
                          if (value.trim() && !question.multiSelect) {
                            setAnswers((current) => ({
                              ...current,
                              [question.id]: [],
                            }));
                          }
                        }}
                        value={customAnswers[question.id] ?? ""}
                      />
                    </Field>
                  )}
                </FieldSet>
              ))}
              <Button
                disabled={busy}
                onClick={() =>
                  void answerQuestion(batch.id as string, questions)
                }
              >
                {t("answer")}
              </Button>
            </CardContent>
          </Card>
        );
      })}

      {canReplay && (
        <Card>
          <CardHeader>
            <CardTitle>{t("replay")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("replayDescription")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Select onValueChange={setReplayNodeId} value={replayNodeId}>
                <SelectTrigger className="min-w-72">
                  <SelectValue placeholder={t("selectReplayStep")} />
                </SelectTrigger>
                <SelectContent>
                  {run.version.definition.nodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name ?? labels.kind(node.kind)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!replayNodeId || busy}
                onClick={() => void prepareReplay()}
                variant="outline"
              >
                <RotateCcw /> {t("prepareReplay")}
              </Button>
            </div>
            {preview && (
              <div className="space-y-3 rounded-xl border p-4">
                <p className="font-medium">
                  {t("replayAffected", {
                    count: preview.affectedNodeIds.length,
                  })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {preview.affectedNodeIds
                    .map((nodeId) => {
                      const node = run.version.definition.nodes.find(
                        ({ id }) => id === nodeId,
                      );
                      return node
                        ? (node.name ?? labels.kind(node.kind))
                        : nodeId;
                    })
                    .join(", ")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("replayReusedNote", {
                    count:
                      run.version.definition.nodes.length -
                      preview.affectedNodeIds.length,
                  })}
                </p>
                {preview.warning && (
                  <Alert variant="destructive">
                    <AlertDescription>{preview.warning}</AlertDescription>
                  </Alert>
                )}
                {preview.gitComparison && (
                  <ScrollArea className="h-64 rounded-lg bg-muted">
                    <pre className="min-w-max p-3 text-xs">
                      {jsonText(preview.gitComparison)}
                    </pre>
                  </ScrollArea>
                )}
                {preview.externalEffects.length > 0 && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t("externalEffectsWarning")}
                      <ul className="mt-2 list-disc pl-5">
                        {preview.externalEffects.map((effect) => (
                          <li key={`${effect.kind}:${effect.resourceId}`}>
                            {effect.label ?? effect.kind} ({effect.resourceId})
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => void executeReplay(false, false)}
                  >
                    <RotateCcw /> {t("replayWithoutRestore")}
                  </Button>
                  {preview.checkpointId && (
                    <Button
                      disabled={busy}
                      onClick={() => void executeReplay(true, false)}
                      variant="outline"
                    >
                      {t("restoreAndReplay")}
                    </Button>
                  )}
                  {preview.checkpointId && (
                    <Button
                      disabled={busy}
                      onClick={() => void executeReplay(true, true)}
                      variant="outline"
                    >
                      {t("stashRestoreReplay")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="timeline">
        <TabsList className="flex-wrap">
          <TabsTrigger value="timeline">{t("timeline")}</TabsTrigger>
          <TabsTrigger value="attempts">{t("stepAttempts")}</TabsTrigger>
          <TabsTrigger value="data">{t("sessionData")}</TabsTrigger>
          <TabsTrigger value="resources">{t("resources")}</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-0">
                {hasOlderEvents && (
                  <Button
                    disabled={loadingOlder}
                    onClick={() => void loadOlderEvents()}
                    variant="outline"
                    className="mb-4"
                  >
                    {loadingOlder && <Spinner />}
                    {common("loadMore")}
                  </Button>
                )}
                {events.map((event, index) => (
                  <div
                    className="relative grid grid-cols-[24px_1fr] gap-3 pb-5"
                    key={event.id}
                  >
                    {index < events.length - 1 && (
                      <div className="absolute top-5 bottom-0 left-[11px] w-px bg-border" />
                    )}
                    <div className="z-10 mt-1 size-6 rounded-full border bg-background" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {labels.eventType(event.type)}
                        </Badge>
                        <DateTime kind="relative" value={event.createdAt} />
                      </div>
                      <p className="mt-1 text-sm break-words">
                        {event.message}
                      </p>
                      {event.detail ? (
                        <ScrollArea className="mt-2 h-48 rounded-lg bg-muted">
                          <pre className="p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                            {jsonText(event.detail)}
                          </pre>
                        </ScrollArea>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!events.length && (
                  <Empty className="py-12">
                    <EmptyHeader>
                      <EmptyTitle>{t("noEvents")}</EmptyTitle>
                      <EmptyDescription>{t("timeline")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="attempts">
          <Card>
            <CardContent className="pt-6">
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("step")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead>{t("phase")}</TableHead>
                      <TableHead>{t("generation")}</TableHead>
                      <TableHead>{t("iteration")}</TableHead>
                      <TableHead>{t("attempt")}</TableHead>
                      <TableHead>{t("duration")}</TableHead>
                      <TableHead>{t("error")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {run.attempts.map((attempt) => (
                      <TableRow
                        className={
                          attempt.supersededAt ||
                          attempt.phase === WORKFLOW_REUSED_PHASE
                            ? "opacity-55"
                            : ""
                        }
                        key={attempt.id}
                      >
                        <TableCell>
                          <p className="font-medium">
                            {labels.kind(attempt.kind)}
                          </p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {attempt.nodeId}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={workflowStatusVariant(attempt.status)}
                          >
                            {labels.status(attempt.status)}
                          </Badge>
                          {pendingWaits.has(attempt.id) && (
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              {t("waitingOnKind", {
                                kind: labels.waitKind(
                                  pendingWaits.get(attempt.id)!.kind,
                                ),
                              })}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {labels.phase(attempt.phase)}
                        </TableCell>
                        <TableCell>{attempt.generation}</TableCell>
                        <TableCell>{attempt.iterationKey || "—"}</TableCell>
                        <TableCell>{attempt.attempt}</TableCell>
                        <TableCell>
                          {attempt.startedAt ? (
                            <DateTime
                              kind="relative"
                              value={attempt.startedAt}
                            />
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="max-w-sm text-xs text-destructive">
                          {attempt.error ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {!run.attempts.length && (
                  <Empty className="py-12">
                    <EmptyHeader>
                      <EmptyTitle>{t("stepAttempts")}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="data">
          <Card>
            <CardContent className="pt-6">
              <ScrollArea className="h-[60vh] rounded-xl bg-muted">
                <pre className="min-w-max p-4 text-xs">
                  {jsonText(run.sessionData)}
                </pre>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="resources">
          <Card>
            <CardContent className="pt-6">
              <ItemGroup className="gap-2">
                {run.resourceLinks.map((link) => {
                  const destination = workflowResourceDestination(link);
                  return (
                    <Item key={link.id} variant="outline">
                      <ItemContent>
                        <ItemTitle>{link.label ?? link.kind}</ItemTitle>
                        <ItemDescription>
                          {link.kind} · {link.resourceId}
                        </ItemDescription>
                      </ItemContent>
                      {destination && (
                        <ItemActions>
                          <Button asChild size="sm" variant="outline">
                            <Link
                              href={destination.href}
                              rel={
                                destination.external
                                  ? "noopener noreferrer"
                                  : undefined
                              }
                              target={
                                destination.external ? "_blank" : undefined
                              }
                            >
                              <ExternalLink /> {t("open")}
                            </Link>
                          </Button>
                        </ItemActions>
                      )}
                    </Item>
                  );
                })}
              </ItemGroup>
              {!run.resourceLinks.length && (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyTitle>{t("noResources")}</EmptyTitle>
                    <EmptyDescription>{t("resources")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
