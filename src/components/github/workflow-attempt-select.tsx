"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitHubWorkflowRunAttemptView } from "@/services/github/types";

const ATTEMPT_FIELDS =
  "workflowRunId runAttempt status url startedAt createdAt updatedAt jobs { id name status url canRetry retryUnavailableReason runAttempt steps { number name status } }";

export function WorkflowAttemptSelect({
  repositoryId,
  workflowRunId,
  latestAttempt,
  onAttemptChange,
}: {
  repositoryId: string;
  workflowRunId: string;
  latestAttempt: number;
  onAttemptChange: (attempt: GitHubWorkflowRunAttemptView | null) => void;
}) {
  const t = useTranslations("githubAutomation");
  const [value, setValue] = useState("latest");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cache, setCache] = useState<
    Record<number, GitHubWorkflowRunAttemptView>
  >({});

  if (latestAttempt <= 1) return null;

  const select = async (next: string) => {
    setValue(next);
    setError(null);
    if (next === "latest") {
      onAttemptChange(null);
      return;
    }
    const attempt = Number(next);
    if (cache[attempt]) {
      onAttemptChange(cache[attempt]);
      return;
    }
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        githubActionsWorkflowRunAttempt: GitHubWorkflowRunAttemptView;
      }>(
        `query GitHubActionsWorkflowRunAttempt(
          $repositoryId: ID!
          $workflowRunId: ID!
          $attempt: Int!
        ) {
          githubActionsWorkflowRunAttempt(
            repositoryId: $repositoryId
            workflowRunId: $workflowRunId
            attempt: $attempt
          ) { ${ATTEMPT_FIELDS} }
        }`,
        { repositoryId, workflowRunId, attempt },
      );
      setCache((current) => ({
        ...current,
        [attempt]: data.githubActionsWorkflowRunAttempt,
      }));
      onAttemptChange(data.githubActionsWorkflowRunAttempt);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setValue("latest");
      onAttemptChange(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-1">
      <Select
        disabled={loading}
        onValueChange={(next) => void select(next)}
        value={value}
      >
        <SelectTrigger aria-label={t("attemptSelector")} className="h-8 w-48">
          {loading ? <Spinner /> : null}
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="latest">
            {t("latestAttempt", { attempt: latestAttempt })}
          </SelectItem>
          {Array.from(
            { length: latestAttempt - 1 },
            (_, index) => latestAttempt - index - 1,
          ).map((attempt) => (
            <SelectItem key={attempt} value={String(attempt)}>
              {t("attempt", { attempt })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
