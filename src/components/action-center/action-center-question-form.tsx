"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatKindLabel } from "@/lib/enum-label";

import { useActionCenter } from "./action-center-provider";
import type { ActionCenterItem, ActionCenterQuestionBatch } from "./types";

export function ActionCenterQuestionForm({
  item,
  batch,
}: {
  item: ActionCenterItem;
  batch: ActionCenterQuestionBatch;
}) {
  const t = useTranslations("actionCenter");
  const { answerQuestion } = useActionCenter();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = batch.questions.every(
    (question) =>
      (selected[question.id]?.length ?? 0) > 0 ||
      Boolean(custom[question.id]?.trim()),
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(
        item,
        batch,
        Object.fromEntries(
          batch.questions.map((question) => {
            const answers = [...(selected[question.id] ?? [])];
            const customAnswer = custom[question.id]?.trim();
            if (customAnswer) answers.push(customAnswer);
            return [question.id, { answers }];
          }),
        ),
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      {batch.sourceKind && (
        <p className="text-xs text-muted-foreground">
          {t("questionFrom", { source: formatKindLabel(batch.sourceKind) })}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {batch.questions.map((question) => (
        <FieldSet key={question.id}>
          <FieldLegend>{question.header || question.prompt}</FieldLegend>
          {question.header && (
            <FieldDescription>{question.prompt}</FieldDescription>
          )}
          {question.options.length > 0 && question.multiSelect && (
            <FieldGroup className="gap-2" data-slot="checkbox-group">
              {question.options.map((option) => {
                const id = `action-answer-${batch.id}-${question.id}-${option.id}`;
                const checked =
                  selected[question.id]?.includes(option.label) ?? false;
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
                        onCheckedChange={(value) =>
                          setSelected((current) => {
                            const next = new Set(current[question.id] ?? []);
                            if (value) next.add(option.label);
                            else next.delete(option.label);
                            return { ...current, [question.id]: [...next] };
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
                setSelected((current) => ({
                  ...current,
                  [question.id]: [value],
                }));
                setCustom((current) => ({ ...current, [question.id]: "" }));
              }}
              value={selected[question.id]?.[0] ?? ""}
            >
              {question.options.map((option) => {
                const id = `action-answer-${batch.id}-${question.id}-${option.id}`;
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
            <Textarea
              aria-label={t("customAnswerFor", {
                question: question.header || question.prompt,
              })}
              className="min-h-20"
              onChange={(event) => {
                setCustom((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }));
                if (!question.multiSelect && event.target.value) {
                  setSelected((current) => ({
                    ...current,
                    [question.id]: [],
                  }));
                }
              }}
              placeholder={t("customAnswer")}
              value={custom[question.id] ?? ""}
            />
          )}
        </FieldSet>
      ))}
      <Button disabled={!complete || busy} onClick={() => void submit()}>
        {busy ? <Spinner /> : <Send />} {t("submitAnswer")}
      </Button>
    </div>
  );
}
