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
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubMergeMethod,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestMergeResult,
  GitHubPullRequestView,
} from "@/services/github/types";

const DEFAULT_EMAIL = "__github_account_default__";

export function MergePullRequestButton({
  pullRequest,
  onMerged,
  size = "sm",
  variant = "outline",
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: {
  pullRequest: Pick<
    GitHubPullRequestView,
    "number" | "repositoryNameWithOwner" | "title"
  >;
  onMerged?: (result: GitHubPullRequestMergeResult) => void | Promise<void>;
  size?: "default" | "sm" | "xs" | "icon" | "icon-sm" | "icon-xs";
  variant?:
    "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const t = useTranslations("pullRequests");
  const [internalOpen, setInternalOpen] = useState(false);
  const [options, setOptions] = useState<GitHubPullRequestMergeOptions | null>(
    null,
  );
  const [method, setMethod] = useState<GitHubMergeMethod | "">("");
  const [commitHeadline, setCommitHeadline] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [authorEmail, setAuthorEmail] = useState(DEFAULT_EMAIL);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner = "", name = ""] = pullRequest.repositoryNameWithOwner.split(
    "/",
    2,
  );
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (!next) {
      setLoading(false);
      setOptions(null);
      setError(null);
    }
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setOptions(null);
      setError(null);
      void controlPlaneRequest<{
        githubPullRequestMergeOptions: GitHubPullRequestMergeOptions;
      }>(
        `query GitHubPullRequestMergeOptions(
          $owner: String!
          $name: String!
          $number: Int!
        ) {
          githubPullRequestMergeOptions(
            owner: $owner
            name: $name
            number: $number
          ) {
            availableMethods
            commitEmails
            defaultCommitEmail
            defaultCommitHeadline
            defaultCommitBody
            canMerge
            blockedReason
          }
        }`,
        { owner, name, number: pullRequest.number },
      )
        .then((data) => {
          if (!active) return;
          const next = data.githubPullRequestMergeOptions;
          setOptions(next);
          setMethod(next.availableMethods[0] ?? "");
          setCommitHeadline(next.defaultCommitHeadline);
          setCommitBody(next.defaultCommitBody);
          setAuthorEmail(next.defaultCommitEmail ?? DEFAULT_EMAIL);
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
  }, [name, open, owner, pullRequest.number]);

  const merge = async () => {
    if (!method || !options?.canMerge || !commitHeadline.trim()) return;
    setMerging(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        mergeGitHubPullRequest: GitHubPullRequestMergeResult;
      }>(
        `mutation MergeGitHubPullRequest(
          $input: MergeGitHubPullRequestInput!
        ) {
          mergeGitHubPullRequest(input: $input) {
            id state url mergedAt
          }
        }`,
        {
          input: {
            owner,
            name,
            number: pullRequest.number,
            method,
            commitHeadline,
            commitBody,
            authorEmail: authorEmail === DEFAULT_EMAIL ? null : authorEmail,
          },
        },
      );
      setOpen(false);
      await onMerged?.(data.mergeGitHubPullRequest);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setMerging(false);
    }
  };

  const blockedReason = options?.blockedReason ?? null;
  return (
    <>
      {showTrigger && (
        <Button
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
          size={size}
          type="button"
          variant={variant}
        >
          <GitMerge />
          {t("merge")}
        </Button>
      )}
      <Dialog
        onOpenChange={(next) => {
          if (!merging) setOpen(next);
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("mergePullRequest")}</DialogTitle>
            <DialogDescription>
              {t("mergePullRequestDescription", {
                repository: pullRequest.repositoryNameWithOwner,
                number: pullRequest.number,
              })}
            </DialogDescription>
          </DialogHeader>

          {loading || (!options && !error) ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner /> {t("loadingMergeOptions")}
            </div>
          ) : (
            <div className="space-y-4">
              {(error || blockedReason) && (
                <Alert variant="destructive">
                  <AlertDescription>{error || blockedReason}</AlertDescription>
                </Alert>
              )}
              {options && (
                <>
                  <div>
                    <Label className="mb-1.5 block" htmlFor="merge-method">
                      {t("mergeType")}
                    </Label>
                    <Select
                      disabled={
                        merging || options.availableMethods.length === 0
                      }
                      onValueChange={(value) =>
                        setMethod(value as GitHubMergeMethod)
                      }
                      value={method}
                    >
                      <SelectTrigger id="merge-method">
                        <SelectValue placeholder={t("selectMergeType")} />
                      </SelectTrigger>
                      <SelectContent>
                        {options.availableMethods.map((value) => (
                          <SelectItem key={value} value={value}>
                            {t(`mergeTypes.${value}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label
                      className="mb-1.5 block"
                      htmlFor="merge-commit-headline"
                    >
                      {t("commitMessage")}
                    </Label>
                    <Input
                      disabled={merging}
                      id="merge-commit-headline"
                      onChange={(event) =>
                        setCommitHeadline(event.target.value)
                      }
                      value={commitHeadline}
                    />
                  </div>
                  <div>
                    <Label className="mb-1.5 block" htmlFor="merge-commit-body">
                      {t("commitDescription")}
                    </Label>
                    <Textarea
                      className="min-h-28"
                      disabled={merging}
                      id="merge-commit-body"
                      onChange={(event) => setCommitBody(event.target.value)}
                      value={commitBody}
                    />
                  </div>
                  <div>
                    <Label className="mb-1.5 block" htmlFor="merge-email">
                      {t("commitEmail")}
                    </Label>
                    <Select
                      disabled={merging}
                      onValueChange={setAuthorEmail}
                      value={authorEmail}
                    >
                      <SelectTrigger id="merge-email">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_EMAIL}>
                          {t("githubDefaultEmail")}
                        </SelectItem>
                        {options.commitEmails.map((email) => (
                          <SelectItem key={email} value={email}>
                            {email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              disabled={merging}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              {t("cancelMerge")}
            </Button>
            <Button
              disabled={
                loading ||
                merging ||
                !options?.canMerge ||
                !method ||
                !commitHeadline.trim()
              }
              onClick={() => void merge()}
              type="button"
            >
              {merging ? <Spinner /> : <GitMerge />}
              {merging ? t("merging") : t("mergePullRequest")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
