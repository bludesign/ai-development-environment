"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { MergeRequestDialog } from "@/components/gitlab/merge-request-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { PostMergeSwitchProgress } from "./post-merge-switch-client";
import { MergePullRequestButton } from "./merge-pull-request-button";
import {
  dismissMergeOperationError,
  dismissMergeOperationProgress,
  useMergeOperationErrors,
  useMergeOperationProgress,
} from "./merge-operation-state";

/** Kept outside result rows, which can disappear after a confirmed merge refreshes. */
export function MergeOperationWarnings({
  provider,
}: {
  provider?: "github" | "gitlab";
}) {
  const t = useTranslations("pullRequests");
  const errors = useMergeOperationErrors().filter(
    (entry) => !provider || JSON.parse(entry.key)[0] === provider,
  );
  const progress = useMergeOperationProgress().filter(
    (entry) => !provider || JSON.parse(entry.key)[0] === provider,
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = [...errors, ...progress].find(
    (entry) => entry.key === selectedKey,
  );
  const target = selected
    ? (JSON.parse(selected.key) as ["github" | "gitlab", string, number])
    : null;
  const close = (open: boolean) => {
    if (!open) setSelectedKey(null);
  };
  if (!errors.length && !progress.length) return null;
  return (
    <div className="space-y-2">
      {progress.map((entry) => (
        <Alert key={entry.key}>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{entry.label}</p>
              <PostMergeSwitchProgress operationKey={entry.key} />
            </div>
            <Button
              onClick={() => setSelectedKey(entry.key)}
              size="sm"
              variant="outline"
            >
              {t("details")}
            </Button>
            {entry.status.state === "COMPLETED" && (
              <Button
                aria-label={t("closeMergeResult")}
                onClick={() => dismissMergeOperationProgress(entry.key)}
                size="icon-sm"
                variant="ghost"
              >
                <X />
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ))}
      {errors.map((entry) => (
        <Alert key={entry.key} variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{entry.label}</p>
              <p>{entry.error}</p>
            </div>
            <Button
              onClick={() => setSelectedKey(entry.key)}
              size="sm"
              variant="outline"
            >
              {t("reviewMergeError")}
            </Button>
            <Button
              aria-label={t("dismissMergeError")}
              onClick={() => dismissMergeOperationError(entry.key)}
              size="icon-sm"
              variant="ghost"
            >
              <X />
            </Button>
          </AlertDescription>
        </Alert>
      ))}
      {target?.[0] === "github" && (
        <MergePullRequestButton
          key={selected!.key}
          pullRequest={{
            repositoryNameWithOwner: target[1],
            number: target[2],
          }}
          requestSource="PULL_REQUESTS_PAGE"
          open
          onOpenChange={close}
          showTrigger={false}
        />
      )}
      {target?.[0] === "gitlab" && (
        <MergeRequestDialog
          key={selected!.key}
          mergeRequest={{
            projectId: target[1],
            iid: target[2],
            title: selected!.label,
          }}
          open
          onOpenChange={close}
        />
      )}
    </div>
  );
}
