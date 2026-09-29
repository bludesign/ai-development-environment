"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { ConfigurationIcon } from "@/components/builds/configuration-icon";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import {
  WorkflowChoiceMenu,
  type WorkflowTriggerChoice,
} from "./workflow-choice-menu";
import { useWorkflowTargetSummary } from "./workflow-target-summaries";

type QuickActionWorkflow = {
  id: string;
  name: string;
  description: string;
  quickActionIconKey: string;
  quickActionButtonVariant: "default" | "outline" | "secondary" | "destructive";
  triggerChoices?: WorkflowTriggerChoice[];
  hasPlainTrigger?: boolean;
};

type WorkflowQuickActionsProps = {
  worktreeId: string;
  sessionData: Record<string, unknown>;
  workflows: QuickActionWorkflow[];
  className?: string;
};

export function WorkflowQuickActions(props: WorkflowQuickActionsProps) {
  if (!props.workflows.length) return null;
  return <WorkflowQuickActionButtons {...props} />;
}

function WorkflowQuickActionButtons({
  worktreeId,
  sessionData,
  workflows,
  className,
}: WorkflowQuickActionsProps) {
  const t = useTranslations("workflows");
  const summary = useWorkflowTargetSummary({
    resourceKind: "WORKTREE",
    resourceId: worktreeId,
  });
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active: Record<string, typeof summary.activeRuns> = {};
  for (const run of summary.activeRuns)
    (active[run.workflowId] ??= []).push(run);

  const trigger = async (
    workflow: QuickActionWorkflow,
    choice: string | null,
  ) => {
    setTriggering(workflow.id);
    setError(null);
    try {
      await controlPlaneRequest<{
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
            choice,
          },
        },
      );
      await summary.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setTriggering(null);
    }
  };

  const displayedError = error ?? summary.error;

  return (
    <div className={cn("w-full space-y-2", className)}>
      <div className="flex flex-wrap gap-2">
        {workflows.map((workflow) => {
          const runs = active[workflow.id] ?? [];
          const busy = runs.length > 0 || triggering === workflow.id;
          return (
            <div className="flex" key={workflow.id}>
              {runs.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={t("manageRuns", { name: workflow.name })}
                      className="rounded-r-none"
                      size="sm"
                      variant="outline"
                    >
                      <Spinner />
                      {runs.length > 1 && (
                        <span className="text-xs tabular-nums">
                          {runs.length}
                        </span>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-48">
                    {runs.map((run, index) => (
                      <div key={run.id}>
                        {index > 0 && <DropdownMenuSeparator />}
                        {runs.length > 1 && (
                          <DropdownMenuLabel className="text-xs text-muted-foreground">
                            {t("runNumber", { number: run.displayNumber })}
                          </DropdownMenuLabel>
                        )}
                        <DropdownMenuItem asChild>
                          <Link href={`/workflows/runs/${run.id}`}>
                            <ExternalLink />
                            {t("quickActionView")}
                          </Link>
                        </DropdownMenuItem>
                      </div>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <WorkflowChoiceMenu
                button={
                  <Button
                    className={
                      runs.length > 0 ? "-ml-px rounded-l-none" : undefined
                    }
                    disabled={triggering !== null}
                    size="sm"
                    title={
                      busy
                        ? t("startAnotherRun", { name: workflow.name })
                        : workflow.description || workflow.name
                    }
                    variant={workflow.quickActionButtonVariant}
                  >
                    {triggering === workflow.id ? (
                      <Spinner />
                    ) : (
                      <ConfigurationIcon
                        iconKey={workflow.quickActionIconKey}
                      />
                    )}
                    {workflow.name}
                  </Button>
                }
                choices={workflow.triggerChoices ?? []}
                hasPlainTrigger={workflow.hasPlainTrigger ?? false}
                onRun={(choice) => void trigger(workflow, choice)}
              />
            </div>
          );
        })}
      </div>
      {displayedError && (
        <Alert variant="destructive">
          <AlertDescription>{displayedError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
