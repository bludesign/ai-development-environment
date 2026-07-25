"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { useWorkflowLabels } from "./workflow-labels";
import type { WorkflowRun } from "./types";

export type WorkflowPendingOption = {
  id: string;
  label: string;
  description: string | null;
};

export type WorkflowPendingQuestion = {
  id: string;
  header: string | null;
  prompt: string;
  multiSelect: boolean;
  options: WorkflowPendingOption[];
};

export type WorkflowPendingBatch = {
  id: string;
  /** Step kind that asked — `HUMAN_CONFIRM`, `HUMAN_CHOICE`, … */
  kind: string;
  questions: WorkflowPendingQuestion[];
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readQuestion(value: unknown): WorkflowPendingQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = text(record.id);
  if (!id) return null;
  const options = Array.isArray(record.options) ? record.options : [];
  return {
    id,
    header: text(record.header),
    prompt: text(record.prompt) ?? "",
    multiSelect: Boolean(record.multiSelect),
    options: options.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const option = entry as Record<string, unknown>;
      const label = text(option.label);
      return label
        ? [
            {
              id: text(option.id) ?? label,
              label,
              description: text(option.description),
            },
          ]
        : [];
    }),
  };
}

/**
 * The question batches this run is currently parked on. The compact run views
 * select the same batch fields the run page does, but as loosely typed JSON, so
 * the shape is re-read defensively here.
 */
export function pendingWorkflowQuestions(
  run: WorkflowRun,
): WorkflowPendingBatch[] {
  return run.attempts.flatMap((attempt) =>
    (attempt.questionBatches ?? []).flatMap((entry) => {
      const batch = entry as Record<string, unknown>;
      const id = text(batch.id);
      if (!id || batch.status !== "PENDING") return [];
      const questions = (
        Array.isArray(batch.questions) ? batch.questions : []
      ).flatMap((question) => readQuestion(question) ?? []);
      return questions.length ? [{ id, kind: attempt.kind, questions }] : [];
    }),
  );
}

/**
 * A batch can be answered from a row of buttons when every question offers
 * options to pick from. Free-text-only questions still need the run page, which
 * is the one place that renders a text box for a custom answer.
 */
function answerableInline(batch: WorkflowPendingBatch): boolean {
  return batch.questions.every(({ options }) => options.length > 0);
}

/**
 * Answer buttons for a run waiting on a person — the confirm step's Confirm and
 * Cancel, or a choice step's options — so a run parked on a decision can be
 * cleared from wherever it is being watched instead of only from the run page.
 *
 * A batch that asks one single-select question (every `HUMAN_CONFIRM`, and a
 * `HUMAN_CHOICE` that does not take several answers) submits on the click that
 * picks an option. Anything else collects selections first and submits from an
 * Answer button, because a partially answered batch is not a valid answer.
 */
export function WorkflowQuestionActions({
  run,
  onAnswered,
}: {
  run: WorkflowRun;
  onAnswered: () => void | Promise<void>;
}) {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const batches = useMemo(() => pendingWorkflowQuestions(run), [run]);

  if (batches.length === 0) return null;

  const key = (batchId: string, questionId: string) =>
    `${batchId}:${questionId}`;

  const submit = async (
    batch: WorkflowPendingBatch,
    answers: Record<string, string[]>,
  ) => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation AnswerWorkflowQuestion($batchId: ID!, $answers: JSON!) { answerWorkflowQuestion(batchId: $batchId, answers: $answers) { id status } }`,
        {
          batchId: batch.id,
          answers: Object.fromEntries(
            batch.questions.map((question) => [
              question.id,
              { answers: answers[question.id] ?? [] },
            ]),
          ),
        },
      );
      setSelected((current) => {
        const next = { ...current };
        for (const question of batch.questions)
          delete next[key(batch.id, question.id)];
        return next;
      });
      setError(null);
      await onAnswered();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {batches.map((batch) => {
        const immediate =
          batch.questions.length === 1 && !batch.questions[0]!.multiSelect;
        const complete = batch.questions.every(
          (question) => (selected[key(batch.id, question.id)] ?? []).length > 0,
        );
        return (
          <div
            className="space-y-3 rounded-xl border border-amber-500/50 bg-amber-500/5 p-3"
            key={batch.id}
          >
            <p className="text-xs text-muted-foreground">
              {t("questionFrom", { step: labels.kind(batch.kind) })}
            </p>
            {answerableInline(batch) ? (
              <>
                {batch.questions.map((question) => {
                  const picked = selected[key(batch.id, question.id)] ?? [];
                  return (
                    <div className="space-y-2" key={question.id}>
                      <p className="text-sm font-medium">
                        {question.header || question.prompt}
                      </p>
                      {question.header && (
                        <p className="text-xs text-muted-foreground">
                          {question.prompt}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {question.options.map((option, index) => (
                          <Button
                            aria-pressed={
                              immediate
                                ? undefined
                                : picked.includes(option.label)
                            }
                            disabled={busy}
                            key={option.id}
                            onClick={() => {
                              if (immediate) {
                                void submit(batch, {
                                  [question.id]: [option.label],
                                });
                                return;
                              }
                              setSelected((current) => {
                                const entry = new Set(
                                  current[key(batch.id, question.id)] ?? [],
                                );
                                if (question.multiSelect) {
                                  if (entry.has(option.label))
                                    entry.delete(option.label);
                                  else entry.add(option.label);
                                } else {
                                  entry.clear();
                                  entry.add(option.label);
                                }
                                return {
                                  ...current,
                                  [key(batch.id, question.id)]: [...entry],
                                };
                              });
                            }}
                            size="sm"
                            title={option.description ?? undefined}
                            variant={
                              picked.includes(option.label)
                                ? "default"
                                : immediate && index === 0
                                  ? "default"
                                  : "outline"
                            }
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {!immediate && (
                  <Button
                    disabled={busy || !complete}
                    onClick={() =>
                      void submit(
                        batch,
                        Object.fromEntries(
                          batch.questions.map((question) => [
                            question.id,
                            selected[key(batch.id, question.id)] ?? [],
                          ]),
                        ),
                      )
                    }
                    size="sm"
                  >
                    {t("answer")}
                  </Button>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-medium">
                  {batch.questions[0]!.header || batch.questions[0]!.prompt}
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/workflows/runs/${run.id}`}>
                    {t("answerOnRunPage")}
                  </Link>
                </Button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
