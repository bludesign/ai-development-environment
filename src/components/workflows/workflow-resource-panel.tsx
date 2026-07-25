"use client";

import { CirclePlay, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

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
} from "@/lib/control-plane-client";
import { currentPageWorkflowNodeIds } from "@/lib/workflows/resource-navigation";

import {
  WorkflowChoiceMenu,
  type WorkflowTriggerChoice,
} from "./workflow-choice-menu";
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
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [workflows, setWorkflows] = useState<AcceptedWorkflow[]>([]);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        workflowRunsForResource: WorkflowRun[];
        workflowsAcceptingResource: AcceptedWorkflow[];
      }>(
        `query ResourceWorkflows($kind: String!, $resourceId: ID!) {
        workflowRunsForResource(kind: $kind, resourceId: $resourceId) { ${LINKED_RUN_FIELDS} }
        workflowsAcceptingResource(kind: $kind) {
          id name description enabled
          triggerChoices(resourceKind: $kind) { key label description }
        }
      }`,
        { kind: resourceKind, resourceId },
      );
      setRuns(data.workflowRunsForResource);
      setWorkflows(data.workflowsAcceptingResource);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [resourceId, resourceKind]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const client = controlPlaneSubscriptions();
    const dispose = client.subscribe<{
      workflowsChanged: { id: string } | null;
    }>(
      {
        query:
          "subscription ResourceWorkflowChanges { workflowsChanged { id } }",
      },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(timer);
      dispose();
    };
  }, [load]);

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
      await load();
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
            <WorkflowQuestionActions onAnswered={load} run={current} />
            <WorkflowGraph
              attempts={current.attempts}
              compact
              currentPageNodeIds={currentPageNodeIds}
              definition={current.version.definition}
              generation={current.generation}
            />
            {runs.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {runs.slice(1, 6).map((run) => (
                  <Button asChild key={run.id} size="sm" variant="ghost">
                    <Link href={`/workflows/runs/${run.id}`}>
                      #{run.displayNumber} · {labels.status(run.status)}
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
