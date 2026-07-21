"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { pipelineStateClass } from "@/components/github/pipeline-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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

const ATTEMPT_METADATA_FIELDS =
  "workflowRunId runAttempt status url triggeringActor { login avatarUrl url } startedAt createdAt updatedAt";
const ATTEMPT_JOB_FIELDS =
  "jobs { id name status url canRetry retryUnavailableReason runAttempt steps { number name status } }";

function attemptDate(value: string, locale: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

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
  const tp = useTranslations("pullRequests");
  const locale = useLocale();
  const [value, setValue] = useState("latest");
  const [loading, setLoading] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<
    Record<number, GitHubWorkflowRunAttemptView>
  >({});
  const metadataRef = useRef<Record<number, GitHubWorkflowRunAttemptView>>({});
  const detailRef = useRef<Record<number, GitHubWorkflowRunAttemptView>>({});
  const metadataRequestsRef = useRef<
    Record<number, Promise<GitHubWorkflowRunAttemptView>>
  >({});
  const detailRequestsRef = useRef<
    Record<number, Promise<GitHubWorkflowRunAttemptView>>
  >({});

  if (latestAttempt <= 1) return null;

  const loadAttempt = (attempt: number, includeJobs: boolean) => {
    const cacheRef = includeJobs ? detailRef : metadataRef;
    const requestsRef = includeJobs ? detailRequestsRef : metadataRequestsRef;
    const cached = cacheRef.current[attempt];
    if (cached) return Promise.resolve(cached);
    const pending = requestsRef.current[attempt];
    if (pending) return pending;

    const request = controlPlaneRequest<{
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
        ) {
          ${ATTEMPT_METADATA_FIELDS}
          ${includeJobs ? ATTEMPT_JOB_FIELDS : ""}
        }
      }`,
      { repositoryId, workflowRunId, attempt },
    ).then((data) => {
      const loaded = data.githubActionsWorkflowRunAttempt;
      cacheRef.current[attempt] = loaded;
      metadataRef.current[attempt] = loaded;
      if (includeJobs) detailRef.current[attempt] = loaded;
      setMetadata((current) => ({ ...current, [attempt]: loaded }));
      return loaded;
    });
    requestsRef.current[attempt] = request;
    void request.then(
      () => delete requestsRef.current[attempt],
      () => delete requestsRef.current[attempt],
    );
    return request;
  };

  const loadMetadata = async () => {
    if (
      Array.from({ length: latestAttempt }, (_, index) => index + 1).every(
        (attempt) => metadataRef.current[attempt],
      )
    ) {
      return;
    }
    setMetadataLoading(true);
    setError(null);
    const results = await Promise.allSettled(
      Array.from({ length: latestAttempt }, (_, index) =>
        loadAttempt(latestAttempt - index, false),
      ),
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) {
      setError(
        rejected.reason instanceof Error
          ? rejected.reason.message
          : String(rejected.reason),
      );
    }
    setMetadataLoading(false);
  };

  const select = async (next: string) => {
    setValue(next);
    setError(null);
    if (next === "latest") {
      onAttemptChange(null);
      return;
    }
    const attempt = Number(next);
    setLoading(true);
    try {
      onAttemptChange(await loadAttempt(attempt, true));
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
        onOpenChange={(open) => {
          if (open) void loadMetadata();
        }}
        onValueChange={(next) => void select(next)}
        value={value}
      >
        <SelectTrigger aria-label={t("attemptSelector")} className="h-8 w-48">
          {loading ? <Spinner /> : null}
          <SelectValue>
            {value === "latest"
              ? t("latestAttempt", { attempt: latestAttempt })
              : t("attempt", { attempt: Number(value) })}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className="w-80" position="popper">
          {Array.from(
            { length: latestAttempt },
            (_, index) => latestAttempt - index,
          ).map((attempt) => {
            const details = metadata[attempt];
            const actor = details?.triggeringActor;
            return (
              <SelectItem
                className="py-2"
                key={attempt}
                textValue={t("attempt", { attempt })}
                value={attempt === latestAttempt ? "latest" : String(attempt)}
              >
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <span className="flex w-full items-center gap-2">
                    <span className="font-medium">
                      {attempt === latestAttempt
                        ? t("latestAttempt", { attempt })
                        : t("attempt", { attempt })}
                    </span>
                    {details ? (
                      <Badge
                        className={`ml-auto ${pipelineStateClass(details.status)}`}
                      >
                        {tp(`pipelineStates.${details.status}`)}
                      </Badge>
                    ) : metadataLoading ? (
                      <Spinner className="ml-auto" />
                    ) : null}
                  </span>
                  {details ? (
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {actor ? (
                        <Avatar className="size-4">
                          <AvatarImage alt="" src={actor.avatarUrl} />
                          <AvatarFallback>
                            {actor.login.slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      ) : null}
                      <span className="truncate">
                        {actor
                          ? t("attemptStartedBy", {
                              date: attemptDate(details.startedAt, locale),
                              actor: actor.login,
                            })
                          : attemptDate(details.startedAt, locale)}
                      </span>
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
