"use client";

import { RefreshCw, Shuffle, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import type { Worktree } from "@/components/worktrees/types";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { ReviewerPerson } from "./reviewer-person";
import {
  WORKTREE_REVIEWER_ASSIGNMENT_FIELDS,
  toggleReviewer,
  type WorktreeReviewerAssignment,
} from "./types";

export function AssignReviewersButton({
  worktree,
  onCompleted,
}: {
  worktree: Pick<Worktree, "id" | "canAssignReviewers">;
  onCompleted: () => Promise<void>;
}) {
  const t = useTranslations("reviewers");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<WorktreeReviewerAssignment | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      setData(null);
      setSelected([]);
      void controlPlaneRequest<{
        worktreeReviewerAssignment: WorktreeReviewerAssignment;
      }>(
        `query WorktreeReviewerAssignment($worktreeId: ID!) {
        worktreeReviewerAssignment(worktreeId: $worktreeId) {
          ${WORKTREE_REVIEWER_ASSIGNMENT_FIELDS}
        }
      }`,
        { worktreeId: worktree.id },
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setData(result.worktreeReviewerAssignment);
          setSelected(result.worktreeReviewerAssignment.selectedReviewerIds);
        })
        .catch((value) => {
          if (!controller.signal.aborted)
            setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, worktree.id, revision]);

  const random = async () => {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await controlPlaneRequest<{
        previewRandomWorktreeReviewers: WorktreeReviewerAssignment;
      }>(
        `query PreviewRandomWorktreeReviewers($worktreeId: ID!, $requestId: ID!, $selectedReviewerIds: [ID!]) {
          previewRandomWorktreeReviewers(worktreeId: $worktreeId, requestId: $requestId, selectedReviewerIds: $selectedReviewerIds) {
            ${WORKTREE_REVIEWER_ASSIGNMENT_FIELDS}
          }
        }`,
        {
          worktreeId: worktree.id,
          requestId: data.requestId,
          selectedReviewerIds: selected,
        },
      );
      setData(result.previewRandomWorktreeReviewers);
      setSelected(result.previewRandomWorktreeReviewers.selectedReviewerIds);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const assign = async () => {
    if (!data || !selected.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await controlPlaneRequest<{
        assignWorktreeReviewers: WorktreeReviewerAssignment;
      }>(
        `mutation AssignWorktreeReviewers($input: AssignWorktreeReviewersInput!) {
          assignWorktreeReviewers(input: $input) { ${WORKTREE_REVIEWER_ASSIGNMENT_FIELDS} }
        }`,
        {
          input: {
            worktreeId: worktree.id,
            requestId: data.requestId,
            reviewerIds: selected,
          },
        },
      );
      setData(result.assignWorktreeReviewers);
      setSelected([]);
      setOpen(false);
      await onCompleted();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  if (!worktree.canAssignReviewers) return null;

  const reviewers = new Map(
    data?.reviewers.map((person) => [person.id, person]),
  );
  const groupedReviewerIds = new Set(
    data?.requirements.flatMap((rule) => [
      ...rule.candidateReviewerIds,
      ...rule.requestedReviewerIds,
      ...rule.approvedReviewerIds,
    ]),
  );
  const otherReviewers = [
    ...new Set([
      ...(data?.currentReviewerIds ?? []),
      ...(data?.approvedReviewerIds ?? []),
    ]),
  ].flatMap((id) =>
    !groupedReviewerIds.has(id) && reviewers.has(id)
      ? [reviewers.get(id)!]
      : [],
  );
  const requestUnavailable = !data?.requestOpen || loading || busy;
  return (
    <Popover
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={t("assignReviewers")}
          onClick={(event) => event.stopPropagation()}
          size="sm"
          type="button"
          variant="outline"
        >
          <UserPlus /> {t("assign")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t("assignReviewers")}
        className="max-h-[min(85dvh,var(--radix-popover-content-available-height))] w-[min(30rem,calc(100vw-2rem))] gap-3 overflow-y-auto"
        collisionPadding={16}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold">{t("assignReviewers")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("assignmentDescription")}
            </p>
          </div>
          <Button
            aria-label={t("reload")}
            disabled={loading || busy}
            onClick={() => setRevision((value) => value + 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw />
          </Button>
        </div>
        {loading && (
          <p className="flex items-center gap-2 text-sm">
            <Spinner />
            {t("loading")}
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {data && (
          <>
            {!data.requestOpen && (
              <Alert>
                <AlertDescription>{t("requestClosed")}</AlertDescription>
              </Alert>
            )}
            {(!data.discoveryComplete || data.issues.length > 0) && (
              <Alert>
                <AlertDescription className="space-y-1">
                  {!data.discoveryComplete && <p>{t("incompleteDiscovery")}</p>}
                  {data.issues.map((issue) => (
                    <p key={issue}>{issue}</p>
                  ))}
                </AlertDescription>
              </Alert>
            )}
            <Command className="min-h-0 flex-1 [&_[data-slot=command-input-wrapper]]:shrink-0">
              <CommandInput
                disabled={requestUnavailable}
                placeholder={t("searchPeople")}
              />
              <CommandList className="min-h-0 flex-1">
                <CommandEmpty>{t("noPeople")}</CommandEmpty>
                {data.requirements.map((requirement) => {
                  const approved = new Set(requirement.approvedReviewerIds);
                  const requested = new Set(
                    requirement.requestedReviewerIds.filter(
                      (id) => !approved.has(id),
                    ),
                  );
                  const additions = new Set(
                    selected.filter(
                      (id) =>
                        requirement.eligibleReviewerIds.includes(id) &&
                        !approved.has(id) &&
                        !requested.has(id),
                    ),
                  );
                  const people = [
                    ...new Set([
                      ...requirement.candidateReviewerIds,
                      ...requirement.requestedReviewerIds,
                      ...requirement.approvedReviewerIds,
                    ]),
                  ].flatMap((id) =>
                    reviewers.has(id) ? [reviewers.get(id)!] : [],
                  );
                  return (
                    <CommandGroup
                      heading={requirement.name}
                      key={requirement.id}
                    >
                      <p className="px-2 pb-2 text-xs text-muted-foreground">
                        {t("requirementCounts", {
                          required: requirement.requiredApprovals,
                          approved: approved.size,
                          requested: requested.size,
                          selected: additions.size,
                        })}
                      </p>
                      {people.map((person) => {
                        const isApproved = approved.has(person.id);
                        const isRequested = data.currentReviewerIds.includes(
                          person.id,
                        );
                        return (
                          <CommandItem
                            aria-label={t("selectReviewer", {
                              name: person.username,
                              group: requirement.name,
                            })}
                            data-checked={selected.includes(person.id)}
                            disabled={
                              requestUnavailable ||
                              isApproved ||
                              isRequested ||
                              person.id === data.authorId
                            }
                            key={person.id}
                            keywords={[
                              person.name,
                              person.username,
                              requirement.name,
                            ]}
                            onSelect={() =>
                              setSelected((previous) =>
                                toggleReviewer(previous, person.id),
                              )
                            }
                            value={`${requirement.id}:${person.id}`}
                          >
                            <ReviewerPerson person={person} />
                            {(isApproved || isRequested) && (
                              <Badge variant="secondary">
                                {isApproved ? t("approved") : t("requested")}
                              </Badge>
                            )}
                          </CommandItem>
                        );
                      })}
                      {!people.length && (
                        <p className="px-2 py-2 text-xs text-muted-foreground">
                          {t("noConfiguredCandidates")}
                        </p>
                      )}
                    </CommandGroup>
                  );
                })}
                {otherReviewers.length > 0 && (
                  <CommandGroup heading={t("existingReviewers")}>
                    {otherReviewers.map((person) => (
                      <CommandItem
                        aria-label={t("existingReviewer", {
                          name: person.username,
                        })}
                        disabled
                        key={person.id}
                        keywords={[person.name, person.username]}
                        value={`existing:${person.id}`}
                      >
                        <ReviewerPerson person={person} />
                        <Badge variant="secondary">
                          {data.approvedReviewerIds.includes(person.id)
                            ? t("approved")
                            : t("requested")}
                        </Badge>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t pt-3">
              <Button
                disabled={requestUnavailable}
                onClick={() => void random()}
                size="sm"
                type="button"
                variant="outline"
              >
                {busy ? <Spinner /> : <Shuffle />} {t("random")}
              </Button>
              <Button
                disabled={requestUnavailable || !selected.length}
                onClick={() => void assign()}
                size="sm"
                type="button"
              >
                {busy ? <Spinner /> : <UserPlus />}{" "}
                {t("assignSelected", { count: selected.length })}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
