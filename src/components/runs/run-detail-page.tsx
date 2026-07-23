"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Bot,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  CircleStop,
  ClipboardList,
  Code2,
  File,
  FileDiff,
  GitFork,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Send,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { ExpandablePatchView } from "@/components/common/patch-view";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { formatProviderLabel } from "@/lib/enum-label";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";

import { RUN_DETAIL_FIELDS, RUN_EVENT_FIELDS } from "./graphql-fields";
import { AttachmentPicker } from "./attachment-picker";
import { MarkdownActions, MarkdownView } from "./markdown-view";
import {
  ModelEffortPicker,
  type ProviderCatalogEntry,
} from "./model-effort-picker";
import { useRunLabels } from "./run-labels";
import type {
  AgentRunView,
  RunAttachmentView,
  RunEventView,
  RunLinkView,
  RunQuestionBatchView,
} from "./types";

type ProviderCatalog = ProviderCatalogEntry & {
  supportsPause: boolean;
  supportsSteering: boolean;
  supportsResume: boolean;
  supportsNativeDelete: boolean;
};

function eventIcon(type: string) {
  const value = type.toUpperCase();
  if (value.includes("QUESTION")) return CircleHelp;
  if (value.includes("COMMAND") || value.includes("TERMINAL")) return Terminal;
  if (value.includes("TOOL")) return Wrench;
  if (value.includes("FILE") || value.includes("DIFF")) return FileDiff;
  if (value.includes("USER")) return MessageSquare;
  if (value.includes("ERROR") || value.includes("FAIL")) return AlertTriangle;
  return Bot;
}

function LinkedRun({ value }: { value: RunLinkView }) {
  const labels = useRunLabels();
  const href = `/${value.kind === "PLAN" ? "plans" : "sessions"}/${value.id}`;
  return (
    <Link
      className="flex items-center gap-2 rounded-lg border p-3 hover:bg-muted/50"
      href={href}
    >
      <GitFork className="size-4" />
      <span className="font-mono">
        {value.kind === "PLAN" ? "Plan" : "Session"} #{value.displayNumber}
      </span>
      {value.followUpMode && (
        <Badge variant="outline">
          {labels.followUpMode(value.followUpMode)}
        </Badge>
      )}
      <Badge className="ml-auto" variant="secondary">
        {labels.status(value.status)}
      </Badge>
    </Link>
  );
}

function answerValues(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const record =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      const values = Array.isArray(record.answers)
        ? record.answers.map(String)
        : typeof record.answer === "string"
          ? [record.answer]
          : [];
      return [key, values];
    }),
  );
}

function QuestionBatch({
  batch,
  editable,
  onAnswered,
}: {
  batch: RunQuestionBatchView;
  editable: boolean;
  onAnswered: () => Promise<void>;
}) {
  const t = useTranslations("runs");
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [stash, setStash] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const value = Object.fromEntries(
        batch.questions.map((question) => {
          const selected = [...(answers[question.id] ?? [])];
          if (custom[question.id]?.trim())
            selected.push(custom[question.id].trim());
          return [question.id, { answers: selected }];
        }),
      );
      await controlPlaneRequest(
        "mutation AnswerQuestion($batchId: ID!, $answers: JSON!) { answerRunQuestion(batchId: $batchId, answers: $answers) { id } }",
        { batchId: batch.id, answers: value },
      );
      await onAnswered();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const latest = batch.answerRevisions.at(-1);
  useEffect(() => {
    if (!preparing) return;
    if (batch.revisionPreparedAt) {
      const timer = window.setTimeout(() => {
        const current = answerValues(latest?.answers);
        const selected: Record<string, string[]> = {};
        const customValues: Record<string, string> = {};
        for (const question of batch.questions) {
          const labels = new Set(question.options.map(({ label }) => label));
          selected[question.id] = (current[question.id] ?? []).filter((value) =>
            labels.has(value),
          );
          customValues[question.id] = (current[question.id] ?? [])
            .filter((value) => !labels.has(value))
            .join("\n");
        }
        setAnswers(selected);
        setCustom(customValues);
        setPreparing(false);
        setEditOpen(true);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setInterval(() => void onAnswered(), 1_000);
    return () => window.clearInterval(timer);
  }, [
    batch.questions,
    batch.revisionPreparedAt,
    latest?.answers,
    onAnswered,
    preparing,
  ]);
  const prepareRevision = async () => {
    setPreparing(true);
    setError(null);
    try {
      await controlPlaneRequest(
        "mutation PrepareAnswerRevision($batchId: ID!) { prepareRunAnswerRevision(batchId: $batchId) { id } }",
        { batchId: batch.id },
      );
      await onAnswered();
    } catch (value) {
      setPreparing(false);
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const revise = async () => {
    setBusy(true);
    try {
      const value = Object.fromEntries(
        batch.questions.map((question) => {
          const selected = [...(answers[question.id] ?? [])];
          if (custom[question.id]?.trim())
            selected.push(custom[question.id].trim());
          return [question.id, { answers: selected }];
        }),
      );
      const data = await controlPlaneRequest<{
        reviseRunAnswer: { id: string; kind: "PLAN" | "SESSION" };
      }>(
        "mutation ReviseAnswer($batchId: ID!, $answers: JSON!, $stash: Boolean!) { reviseRunAnswer(batchId: $batchId, answers: $answers, stash: $stash) { id kind } }",
        { batchId: batch.id, answers: value, stash },
      );
      setEditOpen(false);
      router.push(
        `/${data.reviseRunAnswer.kind === "PLAN" ? "plans" : "sessions"}/${data.reviseRunAnswer.id}`,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const answerEditor = batch.questions.map((question) => (
    <div className="space-y-3" key={question.id}>
      {question.header && <Badge variant="outline">{question.header}</Badge>}
      <p className="font-medium">{question.prompt}</p>
      <div className="space-y-2">
        {question.options.map((option) => {
          const checked = answers[question.id]?.includes(option.label) ?? false;
          return (
            <label
              className="flex items-start gap-3 rounded-lg border p-3"
              key={option.id}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) =>
                  setAnswers((current) => {
                    const selected = new Set(current[question.id] ?? []);
                    if (!question.multiSelect) selected.clear();
                    if (next) selected.add(option.label);
                    else selected.delete(option.label);
                    return { ...current, [question.id]: [...selected] };
                  })
                }
              />
              <span>
                <span className="block font-medium">{option.label}</span>
                {option.description && (
                  <span className="text-sm text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {question.allowCustom && (
        <Input
          aria-label={t("customAnswer")}
          onChange={(event) =>
            setCustom((current) => ({
              ...current,
              [question.id]: event.target.value,
            }))
          }
          placeholder={t("customAnswer")}
          value={custom[question.id] ?? ""}
        />
      )}
    </div>
  ));
  const latestAnswers = answerValues(latest?.answers);
  return (
    <>
      <Card
        className={batch.status === "PENDING" ? "border-primary/50" : undefined}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                {batch.status === "PENDING" ? (
                  <>
                    <CircleHelp /> {t("answerNeeded")}
                  </>
                ) : (
                  t("answeredQuestions")
                )}
              </CardTitle>
              <CardDescription>
                <DateTime value={batch.createdAt} />
              </CardDescription>
            </div>
            {batch.status === "ANSWERED" && editable && (
              <Button
                disabled={preparing}
                onClick={() => void prepareRevision()}
                size="sm"
                variant="outline"
              >
                {preparing ? <Spinner /> : <Pencil />}{" "}
                {preparing ? t("prepareRevision") : t("editAnswer")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {batch.status === "PENDING" ? (
            answerEditor
          ) : (
            <div className="divide-y rounded-lg border">
              {batch.questions.map((question) => (
                <div className="space-y-2 p-3" key={question.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    {question.header && (
                      <Badge variant="outline">{question.header}</Badge>
                    )}
                    <p className="font-medium">{question.prompt}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(latestAnswers[question.id] ?? []).length ? (
                      latestAnswers[question.id]!.map((answer) => (
                        <Badge key={answer} variant="secondary">
                          {answer}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {batch.status === "PENDING" && (
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? <Spinner /> : <Send />} {t("submitAnswers")}
            </Button>
          )}
        </CardContent>
      </Card>
      <Dialog onOpenChange={setEditOpen} open={editOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("editAnswer")}</DialogTitle>
            <DialogDescription>{t("revisionDescription")}</DialogDescription>
          </DialogHeader>
          {batch.pushedCommitWarning && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{batch.pushedCommitWarning}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label>{t("rollbackDiff")}</Label>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
              {batch.rollbackPatch || t("noRollbackChanges")}
            </pre>
          </div>
          <div className="space-y-5">{answerEditor}</div>
          <label className="flex items-center gap-3 rounded-lg border p-3">
            <Checkbox
              checked={stash}
              onCheckedChange={(value) => setStash(Boolean(value))}
            />
            <span>{t("stashBeforeRollback")}</span>
          </label>
          <DialogFooter showCloseButton>
            <Button
              disabled={busy}
              onClick={() => void revise()}
              variant="destructive"
            >
              {busy ? <Spinner /> : <RotateCcw />} {t("confirmRevision")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RunDetailPage({ runId }: { runId: string }) {
  const t = useTranslations("runs");
  const labels = useRunLabels();
  const locale = useLocale();
  const router = useRouter();
  const [run, setRun] = useState<AgentRunView | null>(null);
  const [events, setEvents] = useState<RunEventView[]>([]);
  const [search, setSearch] = useState("");
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [expandedRaw, setExpandedRaw] = useState<Set<string>>(new Set());
  const [promptRaw, setPromptRaw] = useState(false);
  const [outputRaw, setOutputRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [steering, setSteering] = useState("");
  const [steeringAttachments, setSteeringAttachments] = useState<
    RunAttachmentView[]
  >([]);
  const [followMode, setFollowMode] = useState("RESUME");
  const [followPrompt, setFollowPrompt] = useState("");
  const [followProvider, setFollowProvider] = useState("");
  const [followModel, setFollowModel] = useState("");
  const [followEffort, setFollowEffort] = useState("auto");
  const [followWebSearch, setFollowWebSearch] = useState(false);
  const [followAttachments, setFollowAttachments] = useState<
    RunAttachmentView[]
  >([]);
  const [catalog, setCatalog] = useState<ProviderCatalog[]>([]);
  const [contextMode, setContextMode] = useState("NORMALIZED");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [followConfirm, setFollowConfirm] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        agentRun: AgentRunView | null;
        runProviderCatalog: ProviderCatalog[];
      }>(
        `query AgentRunDetail($id: ID!) { agentRun(id: $id) { ${RUN_DETAIL_FIELDS} } runProviderCatalog { key label available supportsWebSearch supportsPause supportsSteering supportsResume supportsNativeDelete models { id label efforts } } }`,
        { id: runId },
      );
      setRun(data.agentRun);
      setCatalog(data.runProviderCatalog);
      if (data.agentRun && !followProvider) {
        setFollowProvider(data.agentRun.provider);
        setFollowModel(data.agentRun.model);
        setFollowEffort(data.agentRun.effort ?? "auto");
        setFollowWebSearch(data.agentRun.webSearchEnabled);
      }
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [followProvider, runId]);
  const refreshEvents = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{ runEvents: RunEventView[] }>(
        `query RunActivity($runId: ID!, $search: String) { runEvents(runId: $runId, search: $search, first: 500) { ${RUN_EVENT_FIELDS} } }`,
        { runId, search: search.trim() || null },
      );
      setEvents(data.runEvents);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [runId, search]);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshEvents(), 150);
    return () => window.clearTimeout(timer);
  }, [refreshEvents]);
  useEffect(() => {
    const subscriptions = controlPlaneSubscriptions();
    const offRun = subscriptions.subscribe(
      {
        query: `subscription RunChanged($runId: ID!) { agentRunChanged(runId: $runId) { ${RUN_DETAIL_FIELDS} } }`,
        variables: { runId },
      },
      {
        next: (value) => {
          const next = (
            value.data as { agentRunChanged?: AgentRunView } | undefined
          )?.agentRunChanged;
          if (next) setRun(next);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const offEvent = subscriptions.subscribe(
      {
        query: `subscription RunEvent($runId: ID!) { runEventAdded(runId: $runId) { ${RUN_EVENT_FIELDS} } }`,
        variables: { runId },
      },
      {
        next: (value) => {
          const next = (
            value.data as { runEventAdded?: RunEventView } | undefined
          )?.runEventAdded;
          if (next)
            setEvents((current) =>
              current.some(({ id }) => id === next.id)
                ? current
                : [...current, next],
            );
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const offQuestion = subscriptions.subscribe(
      {
        query:
          "subscription RunQuestion($runId: ID!) { runQuestionChanged(runId: $runId) { id } }",
        variables: { runId },
      },
      {
        next: () => void refresh(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      offRun();
      offEvent();
      offQuestion();
    };
  }, [refresh, runId]);

  const lifecycle = async (
    action: "pause" | "continue" | "cancel" | "play",
  ) => {
    setBusy(action);
    try {
      const query =
        action === "play"
          ? "mutation Play($id: ID!) { playPlan(planId: $id) { id } }"
          : `mutation Lifecycle($id: ID!) { ${action}AgentRun(id: $id) { id } }`;
      await controlPlaneRequest(query, { id: runId });
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (
    files: File[],
    setter: React.Dispatch<React.SetStateAction<RunAttachmentView[]>>,
  ) => {
    if (!files.length) return;
    setBusy("upload");
    try {
      const uploaded: RunAttachmentView[] = [];
      for (const file of files) {
        const response = await fetch("/api/run-attachments", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-attachment-filename": encodeURIComponent(file.name),
          },
          body: file,
        });
        const value = (await response.json()) as RunAttachmentView & {
          error?: string;
        };
        if (!response.ok) throw new Error(value.error || t("uploadFailed"));
        uploaded.push({
          ...value,
          downloadPath: `/api/run-attachments/${value.id}`,
          createdAt: new Date().toISOString(),
        });
      }
      setter((current) => [...current, ...uploaded]);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  const steer = async () => {
    setBusy("steer");
    try {
      await controlPlaneRequest(
        "mutation Steer($id: ID!, $prompt: String!, $attachments: [ID!]!) { steerAgentRun(id: $id, prompt: $prompt, attachmentIds: $attachments) { id } }",
        {
          id: runId,
          prompt: steering,
          attachments: steeringAttachments.map(({ id }) => id),
        },
      );
      setSteering("");
      setSteeringAttachments([]);
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  const createFollowUp = async () => {
    if (!run?.worktreeId) return;
    setBusy("follow");
    try {
      const prompt =
        followMode === "RESEND" && !followPrompt.trim()
          ? run.initialPrompt
          : followPrompt;
      const data = await controlPlaneRequest<{
        createRunFollowUp: { id: string; kind: string };
      }>(
        "mutation FollowUp($sourceId: ID!, $input: RunConfigurationInput!) { createRunFollowUp(sourceId: $sourceId, input: $input) { id kind } }",
        {
          sourceId: run.id,
          input: {
            kind: run.kind,
            worktreeId: run.worktreeId,
            jiraIssueKey: run.jiraIssueKey,
            jiraSummary: run.jiraSummary,
            provider: followProvider,
            model: followModel,
            effort: followEffort === "auto" ? null : followEffort,
            webSearchEnabled: followWebSearch,
            prompt,
            attachmentIds: followAttachments.map(({ id }) => id),
            followUpMode: followMode,
            contextMode:
              followProvider === run.provider ? "NATIVE" : contextMode,
          },
        },
      );
      router.push(
        `/${data.createRunFollowUp.kind === "PLAN" ? "plans" : "sessions"}/${data.createRunFollowUp.id}`,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
      setFollowConfirm(false);
    }
  };

  const remove = async () => {
    try {
      await controlPlaneRequest(
        "mutation DeleteRun($id: ID!) { deleteAgentRuns(ids: [$id]) }",
        { id: runId },
      );
      router.push(run?.kind === "PLAN" ? "/plans" : "/sessions");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const linked = useMemo(
    () =>
      run
        ? [
            run.sourcePlan,
            run.parentRun,
            run.playedSession,
            ...run.followUps,
          ].filter(
            (value): value is RunLinkView =>
              Boolean(value) && value!.id !== run.id,
          )
        : [],
    [run],
  );
  if (loading)
    return (
      <p className="flex gap-2 text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  if (!run)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error ?? t("runNotFound")}</AlertDescription>
      </Alert>
    );
  const base = run.kind === "PLAN" ? "/plans" : "/sessions";
  const highlighted = run.worktree?.highlightColor;
  const currency = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
  const terminal = ["COMPLETED", "CANCELLED", "FAILED"].includes(run.status);
  const relationSnapshots = [
    !run.sourcePlan && run.sourcePlanNumber !== null
      ? `${t("plan")} #${run.sourcePlanNumber}`
      : null,
    !run.parentRun && run.parentRunNumber !== null
      ? `${t("parentRun")} #${run.parentRunNumber}`
      : null,
    run.kind === "PLAN" &&
    !run.playedSession &&
    run.playedSessionNumber !== null
      ? `${t("session")} #${run.playedSessionNumber}`
      : null,
  ].filter((value): value is string => Boolean(value));
  const finalPatch = [...run.checkpoints]
    .reverse()
    .find(({ diffPatch }) => diffPatch)?.diffPatch;
  const followCatalog = catalog.find(({ key }) => key === followProvider);
  const runCatalog = catalog.find(({ key }) => key === run.provider);
  const usageBreakdown = [false, true].map((superseded) =>
    run.modelUsage
      .filter((usage) => usage.superseded === superseded)
      .reduce(
        (total, usage) => ({
          input: total.input + usage.inputTokens,
          output: total.output + usage.outputTokens,
          cache: total.cache + usage.cacheReadTokens + usage.cacheWriteTokens,
          cost: total.cost + (usage.estimatedCost ?? 0),
          priced: total.priced || usage.estimatedCost !== null,
          superseded,
        }),
        { input: 0, output: 0, cache: 0, cost: 0, priced: false, superseded },
      ),
  );

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "space-y-4",
          highlighted && "rounded-lg border-l-4 p-4",
          highlighted && worktreeHighlightBackgroundClasses[highlighted],
          highlighted && worktreeHighlightAccentClasses[highlighted],
        )}
      >
        <Button asChild variant="ghost">
          <Link href={base}>
            <ChevronLeft />{" "}
            {t("backTo", {
              kind: run.kind === "PLAN" ? t("plans") : t("sessions"),
            })}
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">
                {run.kind === "PLAN" ? t("plan") : t("session")}{" "}
                <span className="font-mono">#{run.displayNumber}</span>
              </h1>
              <Badge>{labels.status(run.status)}</Badge>
              <Badge variant="outline">{labels.phase(run.phase)}</Badge>
              <Badge variant="secondary">
                {formatProviderLabel(run.provider)}
              </Badge>
              {run.origin === "IMPORTED" && (
                <Badge variant="outline">{t("imported")}</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {run.repositoryName} · {run.branch ?? t("detached")} ·{" "}
              <DateTime value={run.createdAt} />
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {run.origin === "MANAGED" &&
              run.status === "IN_PROGRESS" &&
              runCatalog?.supportsPause && (
                <Button
                  disabled={Boolean(busy)}
                  onClick={() => void lifecycle("pause")}
                  variant="outline"
                >
                  {busy === "pause" ? <Spinner /> : <Pause />} {t("pause")}
                </Button>
              )}
            {run.origin === "MANAGED" && run.status === "PAUSED" && (
              <Button
                disabled={Boolean(busy)}
                onClick={() => void lifecycle("continue")}
              >
                <RotateCcw /> {t("continue")}
              </Button>
            )}
            {run.origin === "MANAGED" && !terminal && (
              <Button
                disabled={Boolean(busy)}
                onClick={() => void lifecycle("cancel")}
                variant="destructive"
              >
                <CircleStop /> {t("cancel")}
              </Button>
            )}
            {run.kind === "PLAN" &&
              run.status === "COMPLETED" &&
              !run.playedAt && (
                <Button
                  disabled={Boolean(busy) || !run.finalOutput}
                  onClick={() => void lifecycle("play")}
                >
                  <Play /> {t("play")}
                </Button>
              )}
            <Button
              onClick={() =>
                void controlPlaneRequest(
                  "mutation Archive($id: ID!, $archived: Boolean!) { archiveAgentRuns(ids: [$id], archived: $archived) }",
                  { id: run.id, archived: !run.archivedAt },
                ).then(refresh)
              }
              variant="outline"
            >
              <Archive /> {run.archivedAt ? t("restore") : t("archive")}
            </Button>
            <Button
              disabled={!runCatalog?.supportsNativeDelete}
              onClick={() => setDeleteOpen(true)}
              variant="destructive"
            >
              <Trash2 /> {t("delete")}
            </Button>
          </div>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {run.error && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{run.error}</AlertDescription>
          </Alert>
        )}
        {run.phase === "IMPORTED_ACTIVE_COLLISION" && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{t("importedCollisionWarning")}</AlertDescription>
          </Alert>
        )}
      </div>

      {(linked.length > 0 || relationSnapshots.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>{t("linkedItems")}</CardTitle>
            <CardDescription>{t("linkedItemsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {linked.map((item) => (
              <LinkedRun key={item.id} value={item} />
            ))}
            {relationSnapshots.map((label) => (
              <div
                className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-muted-foreground"
                key={label}
              >
                <GitFork className="size-4" />
                <span className="font-mono">{label}</span>
                <Badge className="ml-auto" variant="outline">
                  {t("deleted")}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("prompt")}</CardTitle>
            <MarkdownActions
              onRawChange={setPromptRaw}
              raw={promptRaw}
              value={run.initialPrompt}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <MarkdownView
            onRawChange={setPromptRaw}
            raw={promptRaw}
            showActions={false}
            value={run.initialPrompt}
          />
          {run.inputs[0]?.attachments.length ? (
            <div className="flex flex-wrap gap-2">
              {run.inputs[0].attachments.map((attachment) => (
                <Button asChild key={attachment.id} size="sm" variant="outline">
                  <a download href={attachment.downloadPath}>
                    <File /> {attachment.filename}
                  </a>
                </Button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
      {run.questionBatches.map((batch) => (
        <QuestionBatch
          batch={batch}
          editable={
            run.origin === "MANAGED" &&
            !batch.supersededAt &&
            Boolean(batch.checkpoint)
          }
          key={batch.id}
          onAnswered={refresh}
        />
      ))}

      <Card>
        <CardHeader>
          <CardTitle>{t("usageCost")}</CardTitle>
          <CardDescription>{t("estimatedCost")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                t("totalCost"),
                run.estimatedCost === null
                  ? "—"
                  : `≈${currency.format(run.estimatedCost)}`,
              ],
              [t("inputTokens"), run.inputTokens.toLocaleString(locale)],
              [t("outputTokens"), run.outputTokens.toLocaleString(locale)],
              [
                t("cacheTokens"),
                (run.cacheReadTokens + run.cacheWriteTokens).toLocaleString(
                  locale,
                ),
              ],
              [
                t("reasoningTokens"),
                run.reasoningTokens.toLocaleString(locale),
              ],
              [t("toolCalls"), run.toolCallCount.toLocaleString(locale)],
            ].map(([label, value]) => (
              <div className="rounded-lg border p-3" key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {value}
                </p>
              </div>
            ))}
          </div>
          {run.modelUsage.some(({ superseded }) => superseded) && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("usageState")}</TableHead>
                  <TableHead>{t("inputTokens")}</TableHead>
                  <TableHead>{t("outputTokens")}</TableHead>
                  <TableHead>{t("cacheTokens")}</TableHead>
                  <TableHead>{t("cost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usageBreakdown.map((usage) => (
                  <TableRow key={String(usage.superseded)}>
                    <TableCell>
                      {usage.superseded ? t("superseded") : t("activeUsage")}
                    </TableCell>
                    <TableCell>{usage.input.toLocaleString(locale)}</TableCell>
                    <TableCell>{usage.output.toLocaleString(locale)}</TableCell>
                    <TableCell>{usage.cache.toLocaleString(locale)}</TableCell>
                    <TableCell>
                      {usage.priced ? `≈${currency.format(usage.cost)}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {run.modelUsage.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("model")}</TableHead>
                  <TableHead>{t("inputTokens")}</TableHead>
                  <TableHead>{t("outputTokens")}</TableHead>
                  <TableHead>{t("cacheTokens")}</TableHead>
                  <TableHead>{t("cost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.modelUsage.map((usage) => (
                  <TableRow key={usage.id}>
                    <TableCell>
                      {usage.model}
                      {usage.superseded && (
                        <Badge className="ml-2" variant="outline">
                          {t("superseded")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {usage.inputTokens.toLocaleString(locale)}
                    </TableCell>
                    <TableCell>
                      {usage.outputTokens.toLocaleString(locale)}
                    </TableCell>
                    <TableCell>
                      {(
                        usage.cacheReadTokens + usage.cacheWriteTokens
                      ).toLocaleString(locale)}
                    </TableCell>
                    <TableCell>
                      {usage.estimatedCost === null
                        ? "—"
                        : `≈${currency.format(usage.estimatedCost)}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {run.toolCalls.length > 0 && (
            <div>
              <h3 className="mb-2 font-medium">{t("toolCalls")}</h3>
              <div className="space-y-2">
                {run.toolCalls.map((call) => (
                  <details
                    className={cn(
                      "rounded-lg border p-3",
                      call.supersededAt && "opacity-60",
                    )}
                    key={call.id}
                  >
                    <summary className="cursor-pointer">
                      <Wrench className="mr-2 inline size-4" />
                      {call.name}{" "}
                      <Badge className="ml-2" variant="outline">
                        {labels.toolCallStatus(call.status)}
                      </Badge>
                      {call.supersededAt && (
                        <Badge className="ml-2" variant="outline">
                          {t("superseded")}
                        </Badge>
                      )}
                    </summary>
                    <pre className="mt-3 overflow-auto text-xs">
                      {JSON.stringify(
                        {
                          input: call.input,
                          output: call.output,
                          error: call.error,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{t("activity")}</CardTitle>
              <CardDescription>{t("activityDescription")}</CardDescription>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="absolute top-1.5 left-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label={t("searchActivity")}
                className="h-7 pl-8 text-xs"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchActivity")}
                value={search}
              />
            </div>
          </div>
        </CardHeader>
        <div className="max-h-[48rem] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="h-7 w-10" />
                <TableHead className="h-7">{t("activity")}</TableHead>
                <TableHead className="h-7 w-40">{t("status")}</TableHead>
                <TableHead className="h-7 w-24">{t("age")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => {
                const Icon = eventIcon(event.type);
                const raw = expandedRaw.has(event.id);
                const expanded = expandedEvents.has(event.id);
                return (
                  <Fragment key={event.id}>
                    <TableRow
                      aria-expanded={expanded}
                      className={cn(
                        "cursor-pointer",
                        event.supersededAt && "opacity-60",
                      )}
                      onClick={() =>
                        setExpandedEvents((current) => {
                          const next = new Set(current);
                          if (next.has(event.id)) next.delete(event.id);
                          else next.add(event.id);
                          return next;
                        })
                      }
                    >
                      <TableCell className="h-8 py-1">
                        <span className="flex items-center gap-1">
                          <ChevronDown
                            className={cn(
                              "size-3 transition-transform",
                              expanded && "rotate-180",
                            )}
                          />
                          <Icon className="size-3.5" />
                        </span>
                      </TableCell>
                      <TableCell className="h-8 max-w-0 py-1 text-xs">
                        <span className="block truncate">{event.summary}</span>
                      </TableCell>
                      <TableCell className="h-8 py-1">
                        <Badge className="h-5 text-[10px]" variant="outline">
                          {labels.eventType(event.type)}
                        </Badge>
                      </TableCell>
                      <TableCell className="h-8 py-1">
                        <DateTime
                          className="text-xs"
                          kind="time"
                          value={event.createdAt}
                        />
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          className="bg-muted/10 px-4 py-3"
                          colSpan={4}
                        >
                          <div className="space-y-2">
                            {event.detailMarkdown && !raw && (
                              <MarkdownView
                                showActions={false}
                                value={event.detailMarkdown}
                              />
                            )}
                            <Button
                              onClick={() =>
                                setExpandedRaw((current) => {
                                  const next = new Set(current);
                                  if (next.has(event.id)) next.delete(event.id);
                                  else next.add(event.id);
                                  return next;
                                })
                              }
                              size="xs"
                              variant="outline"
                            >
                              <Code2 /> {raw ? t("rendered") : t("raw")}
                            </Button>
                            {raw && (
                              <pre className="max-h-96 overflow-auto rounded bg-muted p-3 text-xs">
                                {JSON.stringify(event.raw, null, 2)}
                              </pre>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {!events.length && (
                <TableRow>
                  <TableCell
                    className="h-20 text-center text-muted-foreground"
                    colSpan={4}
                  >
                    {t("noActivity")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {run.finalOutput && terminal && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>
                {run.kind === "PLAN" ? t("plan") : t("summary")}
              </CardTitle>
              <MarkdownActions
                copy
                onRawChange={setOutputRaw}
                raw={outputRaw}
                value={run.finalOutput}
              />
            </div>
          </CardHeader>
          <CardContent>
            <MarkdownView
              onRawChange={setOutputRaw}
              raw={outputRaw}
              showActions={false}
              value={run.finalOutput}
            />
          </CardContent>
        </Card>
      )}
      {run.origin === "MANAGED" &&
        run.status === "IN_PROGRESS" &&
        runCatalog?.supportsSteering && (
          <Card>
            <CardHeader>
              <CardTitle>{t("steer")}</CardTitle>
              <CardDescription>{t("steerDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                onChange={(event) => setSteering(event.target.value)}
                placeholder={t("steerPlaceholder")}
                value={steering}
              />
              <AttachmentPicker
                attachments={steeringAttachments}
                compact
                onFiles={(files) => upload(files, setSteeringAttachments)}
                onRemove={(id) =>
                  setSteeringAttachments((current) =>
                    current.filter((attachment) => attachment.id !== id),
                  )
                }
                uploading={busy === "upload"}
              />
              <div className="flex justify-end">
                <Button
                  disabled={!steering.trim() || Boolean(busy)}
                  onClick={() => void steer()}
                >
                  {busy === "steer" ? <Spinner /> : <Send />} {t("send")}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

      <Card>
        <CardHeader>
          <CardTitle>{t("followUp")}</CardTitle>
          <CardDescription>{t("followUpDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              onValueChange={(value) => {
                const next = value ?? "RESUME";
                setFollowMode(next);
                if (next === "RESEND") setFollowPrompt(run.initialPrompt);
              }}
              value={followMode}
            >
              <SelectTrigger aria-label={t("followUp")} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  disabled={
                    followProvider === run.provider &&
                    !followCatalog?.supportsResume
                  }
                  value="RESUME"
                >
                  {t("resume")}
                </SelectItem>
                <SelectItem value="FRESH">{t("fresh")}</SelectItem>
                <SelectItem value="RESEND">{t("resend")}</SelectItem>
              </SelectContent>
            </Select>
            <div className="min-w-0 flex-1">
              <ModelEffortPicker
                catalog={catalog}
                effort={followEffort}
                model={followModel}
                onEffortChange={setFollowEffort}
                onModelChange={setFollowModel}
                onProviderChange={(next) => {
                  const entry = catalog.find(({ key }) => key === next);
                  setFollowProvider(next);
                  setFollowModel("");
                  setFollowEffort("auto");
                  setFollowWebSearch(Boolean(entry?.supportsWebSearch));
                }}
                provider={followProvider}
              />
            </div>
          </div>
          {followMode === "RESUME" && followProvider !== run.provider && (
            <div className="space-y-2">
              <Alert>
                <AlertDescription>{t("crossProviderWarning")}</AlertDescription>
              </Alert>
              <Select
                onValueChange={(value) => setContextMode(value ?? "NORMALIZED")}
                value={contextMode}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NORMALIZED">
                    {t("normalizedContext")}
                  </SelectItem>
                  <SelectItem value="SUMMARY">{t("summaryOnly")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <Textarea
            className="min-h-28"
            onChange={(event) => setFollowPrompt(event.target.value)}
            placeholder={
              followMode === "RESEND" ? t("resendPrompt") : t("followUpPrompt")
            }
            value={followPrompt}
          />
          <AttachmentPicker
            attachments={followAttachments}
            compact
            onFiles={(files) => upload(files, setFollowAttachments)}
            onRemove={(id) =>
              setFollowAttachments((current) =>
                current.filter((attachment) => attachment.id !== id),
              )
            }
            uploading={busy === "upload"}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="ml-auto flex items-center gap-2">
              <Checkbox
                checked={followWebSearch}
                disabled={!followCatalog?.supportsWebSearch}
                onCheckedChange={(value) => setFollowWebSearch(Boolean(value))}
              />
              {t("webSearch")}
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              disabled={
                !followPrompt.trim() ||
                Boolean(busy) ||
                !followModel ||
                !followCatalog?.available
              }
              onClick={() =>
                run.status === "PAUSED" && run.kind === "SESSION"
                  ? setFollowConfirm(true)
                  : void createFollowUp()
              }
            >
              {busy === "follow" ? <Spinner /> : <GitFork />}{" "}
              {t("startFollowUp")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {run.checkpoints.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("changesSnapshots")}</CardTitle>
            <CardDescription>
              {t("changesSnapshotsDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {run.kind === "PLAN" && finalPatch && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{t("planMutationWarning")}</AlertDescription>
              </Alert>
            )}
            {finalPatch && <ExpandablePatchView patch={finalPatch} />}
            {run.checkpoints.map((checkpoint) => (
              <details className="rounded-lg border p-3" key={checkpoint.id}>
                <summary className="cursor-pointer">
                  <ClipboardList className="mr-2 inline size-4" />
                  {labels.checkpointKind(checkpoint.kind)} ·{" "}
                  <DateTime value={checkpoint.createdAt} />
                  {checkpoint.branch && (
                    <Badge className="ml-2" variant="outline">
                      {checkpoint.branch}
                    </Badge>
                  )}
                </summary>
                <div className="mt-3 space-y-2 text-sm">
                  <p className="font-mono text-xs">
                    HEAD {checkpoint.headSha ?? "—"}
                  </p>
                  {checkpoint.diffPatch ? (
                    <ExpandablePatchView patch={checkpoint.diffPatch} />
                  ) : checkpoint.diffSummary ? (
                    <pre className="overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
                      {checkpoint.diffSummary}
                    </pre>
                  ) : (
                    <p className="text-muted-foreground">{t("noChanges")}</p>
                  )}
                  {checkpoint.stashRef && (
                    <p className="font-mono text-xs">
                      {t("stashCreated")}: {checkpoint.stashRef}
                    </p>
                  )}
                  {checkpoint.refName && (
                    <p className="font-mono text-xs text-muted-foreground">
                      {checkpoint.refName}
                    </p>
                  )}
                </div>
              </details>
            ))}
          </CardContent>
        </Card>
      )}

      <ConfirmationDialog
        actionLabel={t("delete")}
        cancelLabel={t("cancel")}
        description={t("deleteDescription")}
        onConfirm={remove}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("deleteTitle")}
      />
      <ConfirmationDialog
        actionLabel={t("cancelAndTransfer")}
        cancelLabel={t("cancel")}
        description={t("pausedFollowUpDescription")}
        onConfirm={createFollowUp}
        onOpenChange={setFollowConfirm}
        open={followConfirm}
        title={t("pausedFollowUpTitle")}
      />
    </div>
  );
}
