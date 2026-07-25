"use client";

import { CirclePlay, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { ConfigurationIcon } from "@/components/builds/configuration-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { WorkflowResourcePanel } from "./workflow-resource-panel";
import type { WorkflowTriggerChoice } from "./workflow-choice-menu";

type GitHubQuickAction = {
  id: string;
  name: string;
  description: string;
  quickActionIconKey: string;
  triggerChoices: WorkflowTriggerChoice[];
  hasPlainTrigger: boolean;
};

export type WorkflowMenuResource = {
  kind: "GITHUB_PIPELINE" | "GITHUB_JOB";
  id: string;
  repositoryId: string | null;
  sessionData: Record<string, unknown>;
};

const quickActionCache = new Map<string, Promise<GitHubQuickAction[]>>();
const cacheListeners = new Set<() => void>();
let cacheSubscriptionStarted = false;

function cacheKey(
  kind: WorkflowMenuResource["kind"],
  repositoryId: string | null,
) {
  return `${repositoryId ?? "all"}:${kind}`;
}

function loadQuickActions(
  kind: WorkflowMenuResource["kind"],
  repositoryId: string | null,
) {
  const key = cacheKey(kind, repositoryId);
  const existing = quickActionCache.get(key);
  if (existing) return existing;
  const request = controlPlaneRequest<{
    workflowQuickActions: GitHubQuickAction[];
  }>(
    `query GitHubWorkflowQuickActions(
      $resourceKind: String!
      $repositoryId: ID
    ) {
      workflowQuickActions(
        kind: GITHUB_ACTIONS
        resourceKind: $resourceKind
        repositoryId: $repositoryId
      ) {
        id name description quickActionIconKey
        hasPlainTrigger(resourceKind: $resourceKind)
        triggerChoices(resourceKind: $resourceKind) { key label description }
      }
    }`,
    {
      resourceKind: kind,
      repositoryId,
    },
  ).then(({ workflowQuickActions }) => workflowQuickActions);
  quickActionCache.set(key, request);
  void request.catch(() => {
    if (quickActionCache.get(key) === request) quickActionCache.delete(key);
  });
  return request;
}

function ensureCacheInvalidation() {
  if (cacheSubscriptionStarted || typeof window === "undefined") return;
  cacheSubscriptionStarted = true;
  controlPlaneSubscriptions().subscribe(
    { query: "subscription QuickActionChanges { workflowsChanged { id } }" },
    {
      next: () => {
        quickActionCache.clear();
        for (const listener of cacheListeners) listener();
      },
      error: () => {
        cacheSubscriptionStarted = false;
      },
      complete: () => {
        cacheSubscriptionStarted = false;
      },
    },
  );
}

function useGitHubQuickActions(resource: WorkflowMenuResource) {
  const [workflows, setWorkflows] = useState<GitHubQuickAction[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    ensureCacheInvalidation();
    const invalidate = () => setRevision((current) => current + 1);
    cacheListeners.add(invalidate);
    return () => {
      cacheListeners.delete(invalidate);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void loadQuickActions(resource.kind, resource.repositoryId)
      .then((value) => {
        if (!cancelled) setWorkflows(value);
      })
      .catch(() => {
        if (!cancelled) setWorkflows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [resource.kind, resource.repositoryId, revision]);
  return workflows;
}

export function WorkflowResourceMenuItems({
  resource,
  onError,
  onOpenLinked,
}: {
  resource: WorkflowMenuResource;
  onError: (error: string | null) => void;
  onOpenLinked: () => void;
}) {
  const t = useTranslations("workflows");
  const workflows = useGitHubQuickActions(resource);
  const [triggering, setTriggering] = useState<string | null>(null);

  const trigger = useCallback(
    async (workflowId: string, choice: string | null) => {
      setTriggering(workflowId);
      try {
        await controlPlaneRequest(
          `mutation TriggerGitHubResourceWorkflow($input: TriggerWorkflowInput!) {
            triggerWorkflow(input: $input) { id }
          }`,
          {
            input: {
              workflowId,
              sessionData: resource.sessionData,
              resourceKind: resource.kind,
              resourceId: resource.id,
              subjectKey: `${resource.kind}:${resource.id}`,
              choice,
            },
          },
        );
        onError(null);
      } catch (value) {
        onError(value instanceof Error ? value.message : String(value));
      } finally {
        setTriggering(null);
      }
    },
    [onError, resource],
  );

  return (
    <>
      {workflows.length ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("quickActions")}</DropdownMenuLabel>
          {workflows.map((workflow) => {
            const choices = workflow.triggerChoices ?? [];
            if (choices.length) {
              return (
                <DropdownMenuSub key={workflow.id}>
                  <DropdownMenuSubTrigger disabled={triggering !== null}>
                    {triggering === workflow.id ? (
                      <Spinner />
                    ) : (
                      <ConfigurationIcon
                        iconKey={workflow.quickActionIconKey}
                      />
                    )}
                    {workflow.name}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {workflow.hasPlainTrigger ? (
                      <DropdownMenuItem
                        onSelect={() => void trigger(workflow.id, null)}
                      >
                        <CirclePlay /> {t("run")}
                      </DropdownMenuItem>
                    ) : null}
                    {choices.map((choice) => (
                      <DropdownMenuItem
                        key={choice.key}
                        onSelect={() => void trigger(workflow.id, choice.key)}
                        title={choice.description || undefined}
                      >
                        <CirclePlay /> {choice.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            }
            return (
              <DropdownMenuItem
                disabled={triggering !== null || !workflow.hasPlainTrigger}
                key={workflow.id}
                onSelect={() => void trigger(workflow.id, null)}
                title={workflow.description || undefined}
              >
                {triggering === workflow.id ? (
                  <Spinner />
                ) : (
                  <ConfigurationIcon iconKey={workflow.quickActionIconKey} />
                )}
                {workflow.name}
              </DropdownMenuItem>
            );
          })}
        </>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onOpenLinked}>
        <Workflow /> {t("resourceWorkflows")}
      </DropdownMenuItem>
    </>
  );
}

export function WorkflowResourceDialog({
  resource,
  open,
  onOpenChange,
}: {
  resource: WorkflowMenuResource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("workflows");
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("resourceWorkflows")}</DialogTitle>
          <DialogDescription>
            {t("resourceWorkflowsDescription")}
          </DialogDescription>
        </DialogHeader>
        <WorkflowResourcePanel
          resourceId={resource.id}
          resourceKind={resource.kind}
          sessionData={resource.sessionData}
        />
      </DialogContent>
    </Dialog>
  );
}
