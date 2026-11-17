import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

import { commandStatusKey } from "./types";

export type CommandPortConflict = {
  agentId: string;
  agentName: string;
  port: number;
  runs: Array<{
    id: string;
    displayNumber: number;
    name: string;
    status: string;
  }>;
};

type CommandPortConflictAction = "CONTINUE" | "TERMINATE_AND_RUN";

type Resolution = {
  action: CommandPortConflictAction;
  agentId: string;
  port: number;
  runIds: string[];
};

type Submission = (resolution?: Resolution) => Promise<void>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function readConflict(error: unknown): CommandPortConflict | null {
  if (
    !isRecord(error) ||
    error.code !== "COMMAND_PORT_CONFLICT" ||
    !isRecord(error.extensions)
  )
    return null;
  const conflict = error.extensions.portConflict;
  if (
    !isRecord(conflict) ||
    typeof conflict.agentId !== "string" ||
    typeof conflict.agentName !== "string" ||
    typeof conflict.port !== "number" ||
    !Array.isArray(conflict.runs) ||
    !conflict.runs.length
  )
    return null;
  const runs = [];
  for (const run of conflict.runs) {
    if (
      !isRecord(run) ||
      typeof run.id !== "string" ||
      typeof run.displayNumber !== "number" ||
      typeof run.name !== "string" ||
      typeof run.status !== "string"
    )
      return null;
    runs.push({
      id: run.id,
      displayNumber: run.displayNumber,
      name: run.name,
      status: run.status,
    });
  }
  return {
    agentId: conflict.agentId,
    agentName: conflict.agentName,
    port: conflict.port,
    runs,
  };
}

export function CommandPortConflictRuns({
  runs,
}: {
  runs: CommandPortConflict["runs"];
}) {
  const t = useTranslations("commands");
  return (
    <ul className="max-h-44 space-y-1 overflow-auto text-sm">
      {runs.map((run) => (
        <li
          className="flex flex-wrap items-baseline justify-between gap-x-2"
          key={run.id}
        >
          <Link
            className="font-medium hover:underline"
            href={`/dashboard/commands/runs/${run.id}`}
          >
            #{run.displayNumber} {run.name}
          </Link>
          <span className="text-xs text-muted-foreground">
            {t(commandStatusKey(run.status))}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function useCommandPortConflict() {
  const t = useTranslations("commands");
  const [pending, setPending] = useState<{
    conflict: CommandPortConflict;
    submit: Submission;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (
    perform: Submission,
    onError: (error: string) => void,
  ) => {
    try {
      await perform();
    } catch (value) {
      const conflict = readConflict(value);
      if (conflict) {
        setError(null);
        setPending({ conflict, submit: perform });
      } else onError(value instanceof Error ? value.message : String(value));
    }
  };

  const resolve = async (action: CommandPortConflictAction) => {
    if (!pending || resolving) return;
    setResolving(true);
    setError(null);
    try {
      const { conflict } = pending;
      await pending.submit({
        action,
        agentId: conflict.agentId,
        port: conflict.port,
        runIds: conflict.runs.map(({ id }) => id),
      });
      setPending(null);
    } catch (value) {
      const conflict = readConflict(value);
      if (conflict) setPending({ ...pending, conflict });
      else setError(value instanceof Error ? value.message : String(value));
    } finally {
      setResolving(false);
    }
  };

  return {
    submit,
    pending: Boolean(pending),
    dialog: (
      <AlertDialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open && !resolving) setPending(null);
        }}
      >
        {pending && (
          <AlertDialogContent className="sm:max-w-lg">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("portConflictTitle", { port: pending.conflict.port })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("portConflictDescription", {
                  agent: pending.conflict.agentName,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <CommandPortConflictRuns runs={pending.conflict.runs} />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={resolving}>
                {t("cancel")}
              </AlertDialogCancel>
              <Button
                disabled={resolving}
                onClick={() => void resolve("CONTINUE")}
                variant="outline"
              >
                {t("portConflictContinue")}
              </Button>
              <Button
                disabled={resolving}
                onClick={() => void resolve("TERMINATE_AND_RUN")}
                variant="destructive"
              >
                {t("portConflictTerminate")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    ),
  };
}
