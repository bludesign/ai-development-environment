"use client";

import { CirclePlay, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";
import {
  currentPageWorkflowNodeIds,
  workflowRunNodeDestinations,
} from "@/lib/workflows/resource-navigation";

import {
  WorkflowChoiceMenu,
  type WorkflowTriggerChoice,
} from "./workflow-choice-menu";
import { useOpenWorkflowDestination } from "./use-workflow-destination";
import { WorkflowGraph, workflowStatusVariant } from "./workflow-graph";
import { useWorkflowLabels } from "./workflow-labels";
import { WorkflowQuestionActions } from "./workflow-question-actions";
import type { WorkflowRun } from "./types";

type AcceptedWorkflow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  triggerChoices: WorkflowTriggerChoice[];
  hasPlainTrigger: boolean;
};

const LINKED_RUN_FIELDS = `
  id displayNumber workflowId triggerKind triggerSubjectKey status phase generation
  sessionData sessionRevision blockedReason error queuedAt startedAt pausedAt finishedAt
  workflow { id name }
  trigger { nodeId }
  version { id workflowId version name description schemaVersion definition contentHash publishedAt }
  attempts {
    id nodeId kind generation iterationKey attempt status phase input output error startedAt finishedAt supersededAt
    resourceLinks { id attemptId kind resourceId label url metadata createdAt }
    questionBatches {
      id status
      questions { id header prompt multiSelect options { id label description } }
    }
  }
  resourceLinks { id attemptId kind resourceId label url metadata createdAt }
`;

export function WorkflowResourcePanel({
  resourceKind,
  resourceId,
  sessionData,
}: {
  resourceKind: string;
  resourceId: string;
  sessionData: Record<string, unknown>;
}) {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
  const openDestination = useOpenWorkflowDestination();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [recentRuns, setRecentRuns] = useState<
    Array<Pick<WorkflowRun, "id" | "displayNumber" | "status" | "workflow">>
  >([]);
  const [workflows, setWorkflows] = useState<AcceptedWorkflow[]>([]);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catalogDirty = useRef(true);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const includeCatalog = catalogDirty.current;
      catalogDirty.current = false;
      try {
        const data = await controlPlaneRequest<{
          workflowRunsForResource: WorkflowRun[];
          workflowRunSummariesForResource: Array<
            Pick<WorkflowRun, "id" | "displayNumber" | "status" | "workflow">
          >;
          workflowsAcceptingResource?: AcceptedWorkflow[];
        }>(
          `query ResourceWorkflows($kind: String!, $resourceId: ID!, $includeCatalog: Boolean!) {
        workflowRunsForResource(kind: $kind, resourceId: $resourceId, first: 1) { ${LINKED_RUN_FIELDS} }
        workflowRunSummariesForResource(kind: $kind, resourceId: $resourceId, first: 6) { id displayNumber status workflow { id name } }
        workflowsAcceptingResource(kind: $kind) @include(if: $includeCatalog) {
          id name description enabled
          hasPlainTrigger(resourceKind: $kind)
          triggerChoices(resourceKind: $kind) { key label description }
        }
      }`,
          { kind: resourceKind, resourceId, includeCatalog },
          { signal },
        );
        if (signal?.aborted) return;
        setRuns(data.workflowRunsForResource);
        setRecentRuns(data.workflowRunSummariesForResource ?? []);
        if (data.workflowsAcceptingResource)
          setWorkflows(data.workflowsAcceptingResource);
        setError(null);
      } catch (value) {
        if (includeCatalog) catalogDirty.current = true;
        if (!signal?.aborted)
          setError(value instanceof Error ? value.message : String(value));
      }
    },
    [resourceId, resourceKind],
  );

  const ownerRef = useRef<ReturnType<typeof createRefreshCoalescer> | null>(
    null,
  );
  const refresh = useCallback(async () => {
    await ownerRef.current?.refresh();
  }, []);
  useEffect(() => {
    catalogDirty.current = true;
    const owner = createRefreshCoalescer(load);
    ownerRef.current = owner;
    const timer = window.setTimeout(() => void owner.refresh(), 0);
    const dispose = controlPlaneSubscriptions().subscribe<{
      workflowChanges: { definitionsChanged: boolean };
    }>(
      {
        query: `subscription ResourceWorkflowChanges($kind: String!, $resourceId: ID!) {
        workflowChanges(resourceKind: $kind, resourceId: $resourceId) { definitionsChanged }
      }`,
        variables: { kind: resourceKind, resourceId },
      },
      {
        next: (result) => {
          if (result.data?.workflowChanges.definitionsChanged)
            catalogDirty.current = true;
          void owner.refresh();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const recover = onControlPlaneRecovery(() => {
      catalogDirty.current = true;
      void owner.refresh();
    });
    return () => {
      window.clearTimeout(timer);
      dispose();
      recover();
      owner.dispose();
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [load, resourceKind, resourceId]);

  const trigger = async (workflowId: string, choice: string | null) => {
    setTriggering(workflowId);
    try {
      await controlPlaneRequest<{ triggerWorkflow: { id: string } }>(
        `mutation TriggerResourceWorkflow($input: TriggerWorkflowInput!) { triggerWorkflow(input: $input) { id } }`,
        {
          input: {
            workflowId,
            sessionData,
            resourceKind,
            resourceId,
            subjectKey: `${resourceKind}:${resourceId}`,
            choice,
          },
        },
      );
      // Stay on the resource page: the run shows up in this card's graph below.
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setTriggering(null);
    }
  };

  const current = runs[0];
  const currentPageNodeIds = useMemo(
    () =>
      current
        ? currentPageWorkflowNodeIds(current, resourceKind, resourceId)
        : new Set<string>(),
    [current, resourceId, resourceKind],
  );
  const nodeDestinations = useMemo(
    () => (current ? workflowRunNodeDestinations(current) : new Map()),
    [current],
  );
  if (!runs.length && !workflows.length && !error) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("resourceWorkflows")}</CardTitle>
        <CardDescription>{t("resourceWorkflowsDescription")}</CardDescription>
        <CardAction>
          <Button asChild size="sm" variant="outline">
            <Link href="/workflows">{t("manageWorkflows")}</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {workflows.length > 0 && (
          <ItemGroup className="gap-2">
            {workflows.map((workflow) => (
              <Item key={workflow.id} size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle>{workflow.name}</ItemTitle>
                  {workflow.description && (
                    <ItemDescription>{workflow.description}</ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <WorkflowChoiceMenu
                    button={
                      <Button
                        disabled={!workflow.enabled || triggering !== null}
                        size="sm"
                        variant="outline"
                      >
                        <CirclePlay /> {t("run")}
                      </Button>
                    }
                    choices={workflow.triggerChoices}
                    hasPlainTrigger={workflow.hasPlainTrigger}
                    onRun={(choice) => void trigger(workflow.id, choice)}
                  />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        {current && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Link
                  className="font-medium hover:underline"
                  href={`/workflows/runs/${current.id}`}
                >
                  {current.workflow.name} #{current.displayNumber}
                </Link>
                <Badge variant={workflowStatusVariant(current.status)}>
                  {labels.status(current.status)}
                </Badge>
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/workflows/runs/${current.id}`}>
                  <ExternalLink /> {t("fullRun")}
                </Link>
              </Button>
            </div>
            <WorkflowQuestionActions onAnswered={refresh} run={current} />
            <WorkflowGraph
              attempts={current.attempts}
              compact
              currentPageNodeIds={currentPageNodeIds}
              definition={current.version.definition}
              destinations={nodeDestinations}
              generation={current.generation}
              onNodeClick={(_nodeId, { destination, locked }) => {
                if (locked) openDestination(destination);
              }}
            />
            {recentRuns.some((run) => run.id !== current.id) && (
              <div className="flex flex-wrap gap-2">
                {recentRuns
                  .filter((run) => run.id !== current.id)
                  .slice(0, 5)
                  .map((run) => (
                    <Button asChild key={run.id} size="sm" variant="ghost">
                      <Link
                        className="gap-2"
                        href={`/workflows/runs/${run.id}`}
                      >
                        <span>
                          #{run.displayNumber} · {run.workflow.name}
                        </span>
                        <Badge variant={workflowStatusVariant(run.status)}>
                          {labels.status(run.status)}
                        </Badge>
                      </Link>
                    </Button>
                  ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
