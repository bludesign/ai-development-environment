"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConfigurationIcon } from "@/components/builds/configuration-icon";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type QuickActionWorkflow = {
  id: string;
  name: string;
  description: string;
  quickActionIconKey: string;
  quickActionButtonVariant: "default" | "outline" | "secondary" | "destructive";
};

const STARTED_RUN_VISIBLE_MS = 5000;

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
  const [startedRuns, setStartedRuns] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const hideTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = hideTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const trigger = async (workflow: QuickActionWorkflow) => {
    setTriggering(workflow.id);
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
      setStartedRuns((current) => ({
        ...current,
        [workflow.id]: data.triggerWorkflow.id,
      }));
      clearTimeout(hideTimers.current.get(workflow.id));
      hideTimers.current.set(
        workflow.id,
        setTimeout(() => {
          hideTimers.current.delete(workflow.id);
          setStartedRuns((current) => {
            const next = { ...current };
            delete next[workflow.id];
            return next;
          });
        }, STARTED_RUN_VISIBLE_MS),
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setTriggering(null);
    }
  };

  if (!workflows.length && !error) return null;

  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap gap-2">
        {workflows.map((workflow) => {
          const startedRunId = startedRuns[workflow.id];
          return (
            <div className="flex items-center" key={workflow.id}>
              {startedRunId && (
                <Button
                  asChild
                  className="rounded-r-none border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-300"
                  size="sm"
                  variant="outline"
                >
                  <Link
                    href={`/workflows/runs/${startedRunId}`}
                    title={t("quickActionStarted", { name: workflow.name })}
                  >
                    <Spinner />
                    {t("quickActionView")}
                  </Link>
                </Button>
              )}
              <Button
                className={startedRunId ? "-ml-px rounded-l-none" : undefined}
                disabled={triggering !== null}
                onClick={() => void trigger(workflow)}
                size="sm"
                title={workflow.description || workflow.name}
                variant={workflow.quickActionButtonVariant}
              >
                {triggering === workflow.id ? (
                  <Spinner />
                ) : (
                  <ConfigurationIcon iconKey={workflow.quickActionIconKey} />
                )}
                {workflow.name}
              </Button>
            </div>
          );
        })}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
