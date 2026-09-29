"use client";

import { GitMerge } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitLabMergeRequestView } from "@/services/gitlab";

type MergeRequestTarget = {
  iid: number;
  projectId: string;
  title: string;
};

type MergeRequestDetails = Pick<
  GitLabMergeRequestView,
  | "detailedMergeStatus"
  | "hasConflicts"
  | "id"
  | "iid"
  | "projectId"
  | "sha"
  | "squashOnMerge"
  | "state"
  | "title"
>;

export function MergeRequestDialog({
  mergeRequest,
  onMerged,
  onOpenChange,
  open,
}: {
  mergeRequest: MergeRequestTarget;
  onMerged?: (mergeRequest: GitLabMergeRequestView) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const t = useTranslations("gitlabPages");
  const [details, setDetails] = useState<MergeRequestDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setDetails(null);
      setError(null);
      void controlPlaneRequest<{
        gitlabMergeRequest: MergeRequestDetails;
      }>(
        `query GitLabMergeRequestForMerge($projectId: ID!, $iid: Int!) {
          gitlabMergeRequest(projectId: $projectId, iid: $iid) {
            id iid projectId title state sha squashOnMerge detailedMergeStatus hasConflicts
          }
        }`,
        {
          projectId: mergeRequest.projectId,
          iid: mergeRequest.iid,
        },
      )
        .then((data) => {
          if (active) setDetails(data.gitlabMergeRequest);
        })
        .catch((value) => {
          if (active)
            setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [mergeRequest.iid, mergeRequest.projectId, open]);

  const merge = async (autoMerge: boolean) => {
    if (!details) return;
    setMerging(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        mergeGitLabMergeRequest: GitLabMergeRequestView;
      }>(
        `mutation MergeGitLabMergeRequestFromMenu($input: MergeGitLabMergeRequestInput!) {
          mergeGitLabMergeRequest(input: $input) {
            id iid projectId title description state draft webUrl sourceBranch targetBranch sha
            author { id username name avatarUrl webUrl }
            reviewers { id username name avatarUrl webUrl }
            labels detailedMergeStatus mergeWhenPipelineSucceeds squashOnMerge hasConflicts
            blockingDiscussionsResolved createdAt updatedAt mergedAt
          }
        }`,
        {
          input: {
            projectId: details.projectId,
            iid: details.iid,
            autoMerge,
            squash: details.squashOnMerge,
            sha: details.sha,
          },
        },
      );
      onOpenChange(false);
      await onMerged?.(data.mergeGitLabMergeRequest);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setMerging(false);
    }
  };

  const canMerge =
    details?.state === "OPENED" && details.hasConflicts === false;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!merging) onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("mergeRequest")}</DialogTitle>
          <DialogDescription>
            !{mergeRequest.iid} · {details?.title ?? mergeRequest.title}
          </DialogDescription>
        </DialogHeader>

        {loading || (!details && !error) ? (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-3">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {details && (
              <p className="text-sm text-muted-foreground">
                {details.detailedMergeStatus}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={merging}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={loading || merging || !canMerge}
            onClick={() => void merge(true)}
            type="button"
            variant="outline"
          >
            {t("autoMerge")}
          </Button>
          <Button
            disabled={loading || merging || !canMerge}
            onClick={() => void merge(false)}
            type="button"
          >
            {merging ? <Spinner /> : <GitMerge />}
            {t("merge")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
