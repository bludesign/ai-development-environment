"use client";

import { CirclePlay, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type QuickActionWorkflow = {
  id: string;
  name: string;
  description: string;
};

export function WorkflowQuickActions({
  worktreeId,
  sessionData,
  workflows,
}: {
  worktreeId: string;
  sessionData: Record<string, unknown>;
  workflows: QuickActionWorkflow[];
}) {
  const t = useTranslations("workflows");
  const [triggering, setTriggering] = useState<string | null>(null);
  const [startedRun, setStartedRun] = useState<{
    id: string;
    workflowName: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trigger = async (workflow: QuickActionWorkflow) => {
    setTriggering(workflow.id);
    setStartedRun(null);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        triggerWorkflow: { id: string };
      }>(
        `mutation RunWorktreeQuickAction($input: TriggerWorkflowInput!) {
          triggerWorkflow(input: $input) { id }
        }`,
        {
          input: {
            workflowId: workflow.id,
            sessionData,
            resourceKind: "WORKTREE",
            resourceId: worktreeId,
            subjectKey: `WORKTREE:${worktreeId}`,
          },
        },
      );
      setStartedRun({
        id: data.triggerWorkflow.id,
        workflowName: workflow.name,
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setTriggering(null);
    }
  };

  if (!workflows.length && !error) return null;

  return (
    <div className="w-full space-y-2 border-t pt-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Zap className="size-3.5" /> {t("quickActions")}
      </p>
      <div className="flex flex-wrap gap-2">
        {workflows.map((workflow) => (
          <Button
            disabled={triggering !== null}
            key={workflow.id}
            onClick={() => void trigger(workflow)}
            size="sm"
            title={workflow.description || workflow.name}
            variant="outline"
          >
            {triggering === workflow.id ? <Spinner /> : <CirclePlay />}
            {workflow.name}
          </Button>
        ))}
      </div>
      {startedRun && (
        <p className="text-xs text-muted-foreground">
          {t("quickActionStarted", { name: startedRun.workflowName })}{" "}
          <Link
            className="font-medium text-primary hover:underline"
            href={`/workflows/runs/${startedRun.id}`}
          >
            {t("viewRun")}
          </Link>
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
