"use client";

import { CirclePlay, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Link, useRouter } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { WorkflowGraph, workflowStatusVariant } from "./workflow-graph";
import type { WorkflowRun } from "./types";

type AcceptedWorkflow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
};

const LINKED_RUN_FIELDS = `
  id displayNumber workflowId triggerKind triggerSubjectKey status phase generation
  sessionData sessionRevision blockedReason error queuedAt startedAt pausedAt finishedAt
  workflow { id name }
  version { id workflowId version name description schemaVersion definition contentHash publishedAt }
  attempts { id nodeId kind generation iterationKey attempt status phase input output error startedAt finishedAt supersededAt resourceLinks { id kind resourceId label url metadata createdAt } }
  resourceLinks { id kind resourceId label url metadata createdAt }
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
  const router = useRouter();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [workflows, setWorkflows] = useState<AcceptedWorkflow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        workflowRunsForResource: WorkflowRun[];
        workflowsAcceptingResource: AcceptedWorkflow[];
      }>(
        `query ResourceWorkflows($kind: String!, $resourceId: ID!) {
        workflowRunsForResource(kind: $kind, resourceId: $resourceId) { ${LINKED_RUN_FIELDS} }
        workflowsAcceptingResource(kind: $kind) { id name description enabled }
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

  const trigger = async (workflowId: string) => {
    try {
      const data = await controlPlaneRequest<{
        triggerWorkflow: { id: string };
      }>(
        `mutation TriggerResourceWorkflow($input: TriggerWorkflowInput!) { triggerWorkflow(input: $input) { id } }`,
        {
          input: {
            workflowId,
            sessionData,
            resourceKind,
            resourceId,
            subjectKey: `${resourceKind}:${resourceId}`,
          },
        },
      );
      router.push(`/workflows/runs/${data.triggerWorkflow.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  if (!runs.length && !workflows.length && !error) return null;
  const current = runs[0];
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("resourceWorkflows")}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("resourceWorkflowsDescription")}
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/workflows">{t("manageWorkflows")}</Link>
        </Button>
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
                  <Button
                    disabled={!workflow.enabled}
                    onClick={() => void trigger(workflow.id)}
                    size="sm"
                    variant="outline"
                  >
                    <CirclePlay /> {t("run")}
                  </Button>
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
                  {current.status}
                </Badge>
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/workflows/runs/${current.id}`}>
                  <ExternalLink /> {t("fullRun")}
                </Link>
              </Button>
            </div>
            <WorkflowGraph
              attempts={current.attempts}
              compact
              definition={current.version.definition}
              generation={current.generation}
            />
            {runs.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {runs.slice(1, 6).map((run) => (
                  <Button asChild key={run.id} size="sm" variant="ghost">
                    <Link href={`/workflows/runs/${run.id}`}>
                      #{run.displayNumber} · {run.status}
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
