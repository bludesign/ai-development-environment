"use client";

import {
  ArrowLeft,
  CirclePause,
  CirclePlay,
  CircleStop,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { WorkflowGraph, workflowStatusVariant } from "./workflow-graph";
import type { WorkflowRun } from "./types";

const RUN_DETAIL_FIELDS = `
  id displayNumber workflowId versionId triggerKind triggerSubjectKey status phase generation
  sessionData sessionRevision blockedReason error queuedAt startedAt pausedAt finishedAt createdAt updatedAt
  workflow { id name }
  version { id workflowId version name description schemaVersion definition contentHash publishedAt }
  attempts {
    id nodeId kind generation iterationKey attempt status phase input output error requiredPaths providedPaths
    resourceLockKey idempotencyKey startedAt finishedAt supersededAt replayedFromId createdAt updatedAt
    resourceLinks { id kind resourceId label url metadata createdAt }
    questionBatches {
      id nativeRequestId eventSequence status createdAt answeredAt supersededAt revisionPreparedAt rollbackPatch pushedCommitWarning
      questions { id position header prompt multiSelect allowCustom options { id position label description } }
      answerRevisions { id revision answers createdAt supersededAt replacementAttemptId }
      checkpoint { id kind headSha branch upstreamSha refName diffSummary stashRef createdAt }
    }
    checkpoints { id kind headSha branch upstreamSha refName diffSummary stashRef createdAt }
  }
  waits { id attemptId kind status predicate externalKey resumeAfter timeoutAt result createdAt resolvedAt updatedAt }
  events { id attemptId sequence type message detail createdAt }
  resourceLinks { id kind resourceId label url metadata createdAt }
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

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function WorkflowRunPage({ runId }: { runId: string }) {
  const t = useTranslations("workflows");
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repairText, setRepairText] = useState("{}");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [replayNodeId, setReplayNodeId] = useState<string>("");
  const [preview, setPreview] = useState<ReplayPreview | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        workflowRun: WorkflowRun | null;
      }>(
        `query WorkflowRunDetail($id: ID!) { workflowRun(id: $id) { ${RUN_DETAIL_FIELDS} } }`,
        { id: runId },
      );
      setRun(data.workflowRun);
      setError(data.workflowRun ? null : t("runNotFound"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [runId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const client = controlPlaneSubscriptions();
    const subscriptions = [
      client.subscribe<{ workflowRunChanged: { id: string } }>(
        {
          query: `subscription WorkflowRunState($id: ID!) { workflowRunChanged(runId: $id) { id } }`,
          variables: { id: runId },
        },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
      client.subscribe<{ workflowRunEventAdded: { id: string } }>(
        {
          query: `subscription WorkflowRunEvents($id: ID!) { workflowRunEventAdded(runId: $id) { id } }`,
          variables: { id: runId },
        },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    ];
    return () => {
      window.clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription());
    };
  }, [load, runId]);

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
    questions: Array<{ id: string }>,
  ) => {
    setBusy(true);
    try {
      const value = Object.fromEntries(
        questions.map(({ id }) => [id, answers[id] ?? ""]),
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
      <div className="flex min-h-80 items-center justify-center">
        <Spinner />
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Button asChild aria-label={t("back")} size="icon" variant="ghost">
            <Link href={`/workflows/${run.workflowId}`}>
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {run.workflow.name} #{run.displayNumber}
              </h1>
              <Badge variant={workflowStatusVariant(run.status)}>
                {run.status}
              </Badge>
              <Badge variant="outline">v{run.version.version}</Badge>
              <Badge variant="outline">
                {t("generationValue", { generation: run.generation })}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {run.triggerKind} · {run.triggerSubjectKey}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            aria-label={t("refresh")}
            onClick={() => void load()}
            size="icon"
            variant="outline"
          >
            <RefreshCw />
          </Button>
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

      <Card>
        <CardHeader>
          <CardTitle>{t("runGraph")}</CardTitle>
        </CardHeader>
        <CardContent>
          <WorkflowGraph
            attempts={run.attempts}
            definition={run.version.definition}
            generation={run.generation}
            onNodeClick={(nodeId) => {
              if (canReplay) setReplayNodeId(nodeId);
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
        const questions = batch.questions as Array<{
          id: string;
          header?: string | null;
          prompt: string;
          options?: Array<{
            id: string;
            label: string;
            description?: string | null;
          }>;
        }>;
        return (
          <Card key={String(batch.id)}>
            <CardHeader>
              <CardTitle>{t("questionFrom", { step: attempt.kind })}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {questions.map((question) => (
                <div className="space-y-2" key={question.id}>
                  <Label htmlFor={`answer-${question.id}`}>
                    {question.header || question.prompt}
                  </Label>
                  {question.header && (
                    <p className="text-sm text-muted-foreground">
                      {question.prompt}
                    </p>
                  )}
                  {question.options?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {question.options.map((option) => (
                        <Button
                          key={option.id}
                          onClick={() =>
                            setAnswers((current) => ({
                              ...current,
                              [question.id]: option.label,
                            }))
                          }
                          size="sm"
                          variant={
                            answers[question.id] === option.label
                              ? "default"
                              : "outline"
                          }
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <Textarea
                    id={`answer-${question.id}`}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                    value={answers[question.id] ?? ""}
                  />
                </div>
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
                      {node.name ?? node.kind}
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
                  {preview.affectedNodeIds.join(", ")}
                </p>
                {preview.warning && (
                  <Alert variant="destructive">
                    <AlertDescription>{preview.warning}</AlertDescription>
                  </Alert>
                )}
                {preview.gitComparison && (
                  <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {jsonText(preview.gitComparison)}
                  </pre>
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
                {run.events.map((event, index) => (
                  <div
                    className="relative grid grid-cols-[24px_1fr] gap-3 pb-5"
                    key={event.id}
                  >
                    {index < run.events.length - 1 && (
                      <div className="absolute top-5 bottom-0 left-[11px] w-px bg-border" />
                    )}
                    <div className="z-10 mt-1 size-6 rounded-full border bg-background" />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{event.type}</Badge>
                        <DateTime kind="relative" value={event.createdAt} />
                      </div>
                      <p className="mt-1 text-sm">{event.message}</p>
                      {event.detail ? (
                        <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-2 text-xs">
                          {jsonText(event.detail)}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!run.events.length && (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    {t("noEvents")}
                  </p>
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
                        className={attempt.supersededAt ? "opacity-55" : ""}
                        key={attempt.id}
                      >
                        <TableCell>
                          <p className="font-medium">{attempt.kind}</p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {attempt.nodeId}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={workflowStatusVariant(attempt.status)}
                          >
                            {attempt.status}
                          </Badge>
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
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="data">
          <Card>
            <CardContent className="pt-6">
              <pre className="max-h-[60vh] overflow-auto rounded-xl bg-muted p-4 text-xs">
                {jsonText(run.sessionData)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="resources">
          <Card>
            <CardContent className="space-y-2 pt-6">
              {run.resourceLinks.map((link) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  key={link.id}
                >
                  <div>
                    <p className="font-medium">{link.label ?? link.kind}</p>
                    <p className="text-xs text-muted-foreground">
                      {link.kind} · {link.resourceId}
                    </p>
                  </div>
                  {link.url && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={link.url}>
                        <ExternalLink /> {t("open")}
                      </Link>
                    </Button>
                  )}
                </div>
              ))}
              {!run.resourceLinks.length && (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {t("noResources")}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
