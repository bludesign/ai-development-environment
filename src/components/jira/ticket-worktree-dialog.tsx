"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/ui/searchable-select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  WorktreeBranchForm,
  type WorktreeBranchSelection,
  type WorktreeBranchTarget,
} from "@/components/worktrees/worktree-branch-form";
import { waitForWorktreeJob } from "@/components/worktrees/worktree-jobs";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type DialogWorktree = {
  id: string;
  codebaseId: string;
  folder: string;
  branch: string | null;
  baseBranch: string | null;
  availability: string;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  activeJob: { id: string } | null;
};

type DialogCodebase = {
  repository: { name: string; displayOrigin: string };
  codebase: {
    id: string;
    folder: string;
    availability: string;
    defaultBranch: string | null;
    localBranches: string[];
    remoteBranches: string[];
  };
  worktrees: DialogWorktree[];
};

type DialogAgent = {
  agent: {
    id: string;
    name: string;
    hostname: string;
    connectionStatus: string;
    capabilities: string[];
  };
  codebases: DialogCodebase[];
};

type DialogOverview = { agents: DialogAgent[] };
type DestinationMode = "NEW_WORKTREE" | "EXISTING_WORKTREE";

function targetFor(
  group: DialogCodebase,
  worktree?: DialogWorktree,
): WorktreeBranchTarget {
  return {
    codebaseId: group.codebase.id,
    ...(worktree ? { worktreeId: worktree.id } : {}),
    defaultBranch: group.codebase.defaultBranch,
    currentBranch: worktree?.branch,
    currentBaseBranch: worktree?.baseBranch,
    localBranches: group.codebase.localBranches,
    remoteBranches: group.codebase.remoteBranches,
    unavailableBranches: group.worktrees.flatMap((candidate) =>
      candidate.branch && candidate.id !== worktree?.id
        ? [candidate.branch]
        : [],
    ),
  };
}

export function TicketWorktreeDialog({
  issueKey,
  open,
  onOpenChange,
}: {
  issueKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("jiraTickets");
  const [overview, setOverview] = useState<DialogOverview | null>(null);
  const [mode, setMode] = useState<DestinationMode>("NEW_WORKTREE");
  const [destinationId, setDestinationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failedSelection, setFailedSelection] =
    useState<WorktreeBranchSelection | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        worktreeOverview: DialogOverview;
      }>(`query TicketWorktreeDestinations {
        worktreeOverview {
          agents {
            agent { id name hostname connectionStatus capabilities }
            codebases {
              repository { name displayOrigin }
              codebase { id folder availability defaultBranch localBranches remoteBranches }
              worktrees {
                id codebaseId folder branch baseBranch availability hasStagedChanges hasUnstagedChanges
                activeJob { id }
              }
            }
          }
        }
      }`);
      setOverview(data.worktreeOverview);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load, open]);

  const eligibleGroups = useMemo(
    () =>
      overview?.agents.flatMap((agentGroup) =>
        agentGroup.codebases.flatMap((group) =>
          agentGroup.agent.connectionStatus === "ONLINE" &&
          agentGroup.agent.capabilities.includes("worktree.branch") &&
          group.codebase.availability === "AVAILABLE"
            ? [{ agentGroup, group }]
            : [],
        ),
      ) ?? [],
    [overview],
  );
  const newDestinations = eligibleGroups.filter(
    ({ group }) => !group.worktrees.some((worktree) => worktree.activeJob),
  );
  const existingDestinations = eligibleGroups.flatMap(({ agentGroup, group }) =>
    group.worktrees.flatMap((worktree) =>
      worktree.availability === "AVAILABLE" && !worktree.activeJob
        ? [{ agentGroup, group, worktree }]
        : [],
    ),
  );
  const effectiveDestinationId =
    mode === "NEW_WORKTREE"
      ? newDestinations.some(
          (entry) => entry.group.codebase.id === destinationId,
        )
        ? destinationId
        : newDestinations.length === 1
          ? newDestinations[0]!.group.codebase.id
          : ""
      : existingDestinations.some(
            (entry) => entry.worktree.id === destinationId,
          )
        ? destinationId
        : existingDestinations.length === 1
          ? existingDestinations[0]!.worktree.id
          : "";
  const selectedNew = newDestinations.find(
    (entry) => entry.group.codebase.id === effectiveDestinationId,
  );
  const selectedExisting = existingDestinations.find(
    (entry) => entry.worktree.id === effectiveDestinationId,
  );
  const target = selectedNew
    ? targetFor(selectedNew.group)
    : selectedExisting
      ? targetFor(selectedExisting.group, selectedExisting.worktree)
      : null;
  const selectedWorktree = selectedExisting?.worktree ?? null;
  const options: SearchableSelectOption[] =
    mode === "NEW_WORKTREE"
      ? newDestinations.map(({ agentGroup, group }) => ({
          value: group.codebase.id,
          label: `${group.repository.name} · ${agentGroup.agent.name}`,
          description: group.codebase.folder,
          keywords: `${group.repository.displayOrigin} ${agentGroup.agent.hostname}`,
        }))
      : existingDestinations.map(({ agentGroup, group, worktree }) => ({
          value: worktree.id,
          label: worktree.branch ?? t("detachedBranch"),
          description: `${group.repository.name} · ${agentGroup.agent.name}`,
          secondaryDescription: worktree.folder,
          keywords: `${group.repository.displayOrigin} ${agentGroup.agent.hostname}`,
        }));

  const run = async (
    selection: WorktreeBranchSelection,
    stashOnFailure = false,
  ) => {
    if (!target) throw new Error(t("selectWorktreeDestination"));
    setBusy(true);
    setNotice(null);
    try {
      const isCreate = mode === "NEW_WORKTREE";
      const data = await controlPlaneRequest<Record<string, { id: string }>>(
        isCreate
          ? `mutation CreateTicketWorktree($input: CreateWorktreeInput!) { createWorktree(input: $input) { id } }`
          : `mutation ChangeTicketWorktree($input: ChangeWorktreeBranchInput!) { changeWorktreeBranch(input: $input) { id } }`,
        {
          input: isCreate
            ? {
                codebaseId: target.codebaseId,
                selection,
                requestId: createClientId(),
              }
            : {
                worktreeId: target.worktreeId,
                selection,
                requestId: createClientId(),
                stashOnFailure,
              },
        },
      );
      const job = isCreate ? data.createWorktree : data.changeWorktreeBranch;
      await waitForWorktreeJob(job!.id);
      setFailedSelection(null);
      setError(null);
      if (isCreate) {
        onOpenChange(false);
        return;
      }
      setNotice(t("ticketBranchChanged"));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const retryWithStash = async () => {
    if (!failedSelection) return;
    try {
      setError(null);
      await run(failedSelection, true);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("ticketWorktreeTitle", { issueKey })}</DialogTitle>
          <DialogDescription>
            {t("ticketWorktreeDescription")}
          </DialogDescription>
        </DialogHeader>
        <Tabs
          onValueChange={(value) => {
            setMode(value as DestinationMode);
            setDestinationId("");
            setFailedSelection(null);
            setError(null);
            setNotice(null);
          }}
          value={mode}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="NEW_WORKTREE">{t("newWorktree")}</TabsTrigger>
            <TabsTrigger value="EXISTING_WORKTREE">
              {t("existingWorktree")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {loading && !overview ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("loadingWorktreeDestinations")}
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <Label className="mb-1.5 block">
                {mode === "NEW_WORKTREE"
                  ? t("agentAndCodebase")
                  : t("existingWorktree")}
              </Label>
              <SearchableSelect
                ariaLabel={t("selectWorktreeDestination")}
                disabled={busy || options.length === 0}
                emptyMessage={t("noWorktreeDestinations")}
                onValueChange={setDestinationId}
                options={options}
                placeholder={t("selectWorktreeDestination")}
                searchPlaceholder={t("searchWorktreeDestinations")}
                showSelectedDetails={mode === "EXISTING_WORKTREE"}
                value={effectiveDestinationId}
              />
            </div>
            {target ? (
              <WorktreeBranchForm
                busy={busy}
                fixedTicketKey={issueKey}
                key={`${mode}:${effectiveDestinationId}:${issueKey}`}
                onSubmit={(selection) => run(selection)}
                onSubmitError={(selection) => {
                  setFailedSelection(
                    mode === "EXISTING_WORKTREE" &&
                      selectedWorktree &&
                      (selectedWorktree.hasStagedChanges ||
                        selectedWorktree.hasUnstagedChanges)
                      ? selection
                      : null,
                  );
                }}
                recovery={
                  failedSelection ? (
                    <Alert>
                      <AlertDescription className="space-y-2">
                        <p>{t("ticketStashRetryHelp")}</p>
                        <Button
                          disabled={busy}
                          onClick={() => void retryWithStash()}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {busy && <Spinner />}
                          {t("stashAndRetry")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : null
                }
                submitLabel={
                  mode === "NEW_WORKTREE"
                    ? t("createTicketWorktree")
                    : t("createAndSwitchBranch")
                }
                target={target}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {options.length
                  ? t("chooseWorktreeDestination")
                  : t("noWorktreeDestinations")}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
