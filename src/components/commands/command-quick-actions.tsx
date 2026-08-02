"use client";

import { CircleStop, ExternalLink, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { ConfigurationIcon } from "@/components/builds/configuration-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import {
  COMMAND_DEFINITION_FIELDS,
  activeCommandRun,
  type CommandDefinition,
} from "./types";

type ActiveRun = { id: string; displayNumber: number; status: string };

const RUN_STATUS_FIELDS = "id displayNumber status";

export function CommandQuickActions({
  agentId,
  worktreeId,
  agentCapabilities,
  title,
  description,
  className,
}: {
  agentId?: string;
  worktreeId?: string;
  agentCapabilities: string[];
  title?: string;
  description?: string;
  className?: string;
}) {
  const t = useTranslations("commands");
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [starting, setStarting] = useState<string | null>(null);
  const [active, setActive] = useState<Record<string, ActiveRun[]>>({});
  const [error, setError] = useState<string | null>(null);
  const upgraded = agentCapabilities.includes("command.run");

  useEffect(() => {
    const query = agentId
      ? `query AgentCommandQuickActions($id: ID!) { eligibleCommandsForAgent(agentId: $id) { ${COMMAND_DEFINITION_FIELDS} } }`
      : `query WorktreeCommandQuickActions($id: ID!) { eligibleCommandsForWorktree(worktreeId: $id) { ${COMMAND_DEFINITION_FIELDS} } }`;
    void Promise.resolve(
      controlPlaneRequest<{
        eligibleCommandsForAgent?: CommandDefinition[];
        eligibleCommandsForWorktree?: CommandDefinition[];
      }>(query, { id: agentId ?? worktreeId }),
    )
      .then((data) => {
        if (!data) return;
        setCommands(
          (
            data.eligibleCommandsForAgent ??
            data.eligibleCommandsForWorktree ??
            []
          ).filter((command) => command.quickActionEnabled),
        );
      })
      .catch((value) =>
        setError(value instanceof Error ? value.message : String(value)),
      );
  }, [agentId, worktreeId]);

  // A run started here can finish, be terminated from the run page, or sit
  // queued behind an exclusive run for a long time. Reloading the runs this
  // target owns keeps the spinner honest instead of leaving it turning forever.
  const loadRuns = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        commandRuns: {
          nodes: Array<ActiveRun & { commandId: string | null }>;
        };
      }>(
        `query QuickActionRuns($id: ID!) { commandRuns(${agentId ? "agentId" : "worktreeId"}: $id, first: 50) { nodes { ${RUN_STATUS_FIELDS} commandId } } }`,
        { id: agentId ?? worktreeId },
      );
      const grouped: Record<string, ActiveRun[]> = {};
      for (const run of data.commandRuns.nodes) {
        if (!run.commandId || !activeCommandRun(run.status)) continue;
        (grouped[run.commandId] ??= []).push({
          id: run.id,
          displayNumber: run.displayNumber,
          status: run.status,
        });
      }
      for (const runs of Object.values(grouped)) {
        runs.sort((left, right) => left.displayNumber - right.displayNumber);
      }
      setActive(grouped);
    } catch {
      // A failed refresh leaves the previous snapshot in place; the next
      // command-run event or user action tries again.
    }
  }, [agentId, worktreeId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadRuns(), 0);
    const client = controlPlaneSubscriptions();
    const dispose = client.subscribe(
      { query: "subscription QuickActionRuns { commandRunsChanged { id } }" },
      {
        next: () => void loadRuns(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      dispose();
    };
  }, [loadRuns]);

  const mutate = async (query: string, variables: Record<string, unknown>) => {
    try {
      await controlPlaneRequest(query, variables);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      await loadRuns();
    }
  };

  // Every click starts its own run. Whether it begins immediately or waits for
  // the target is decided by the command's concurrency mode on the server.
  const start = async (command: CommandDefinition) => {
    setStarting(command.id);
    try {
      await mutate(
        "mutation RunCommandQuickAction($input: StartCommandRunInput!) { startCommandRun(input: $input) { id } }",
        {
          input: {
            commandId: command.id,
            origin: "QUICK_ACTION",
            ...(agentId ? { agentId } : { worktreeId }),
          },
        },
      );
    } finally {
      setStarting(null);
    }
  };

  const terminate = (runId: string) =>
    mutate(
      "mutation TerminateQuickActionRun($id: ID!) { terminateCommandRun(id: $id) { id } }",
      { id: runId },
    );

  // Rerun terminates a run that is still going and starts its successor once
  // the original stops, which is exactly the restart this menu offers.
  const restart = (runId: string) =>
    mutate(
      "mutation RestartQuickActionRun($id: ID!) { rerunCommandRun(id: $id) { id } }",
      { id: runId },
    );

  if (!commands.length && !error) return null;
  const actions = (
    <div
      className={cn("w-full space-y-2", className)}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap gap-2">
        {commands.map((command) => {
          const runs = active[command.id] ?? [];
          const busy = runs.length > 0 || starting === command.id;
          return (
            <div className="flex" key={command.id}>
              {runs.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={t("manageRuns", { name: command.name })}
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
                        <DropdownMenuItem
                          onSelect={() => void terminate(run.id)}
                        >
                          <CircleStop />
                          {t("terminate")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void restart(run.id)}>
                          <RotateCcw />
                          {t("restartRun")}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/commands/runs/${run.id}`}>
                            <ExternalLink />
                            {t("view")}
                          </Link>
                        </DropdownMenuItem>
                      </div>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button
                className={
                  runs.length > 0 ? "-ml-px rounded-l-none" : undefined
                }
                disabled={!upgraded || starting !== null}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void start(command);
                }}
                size="sm"
                title={
                  !upgraded
                    ? t("upgradeAgentTitle")
                    : busy
                      ? t("startAnotherRun", { name: command.name })
                      : command.description || command.name
                }
                variant={
                  (["default", "outline", "secondary", "destructive"].includes(
                    command.quickActionButtonVariant,
                  )
                    ? command.quickActionButtonVariant
                    : "default") as
                    "default" | "outline" | "secondary" | "destructive"
                }
              >
                {starting === command.id ? (
                  <Spinner />
                ) : (
                  <ConfigurationIcon iconKey={command.quickActionIconKey} />
                )}{" "}
                {command.name}
              </Button>
            </div>
          );
        })}
        {!upgraded && commands.length > 0 && (
          <span className="self-center text-xs text-muted-foreground">
            {t("upgradeAgent")}
          </span>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
  if (!title) return actions;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{actions}</CardContent>
    </Card>
  );
}

export function CommandRunLink({ id, label }: { id: string; label: string }) {
  return (
    <Button asChild size="sm" variant="ghost">
      <Link href={`/commands/runs/${id}`}>
        {label}
        <ExternalLink />
      </Link>
    </Button>
  );
}
