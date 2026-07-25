"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { ConfigurationIcon } from "@/components/builds/configuration-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { COMMAND_DEFINITION_FIELDS, type CommandDefinition } from "./types";

export function CommandQuickActions({
  agentId,
  worktreeId,
  agentCapabilities,
}: {
  agentId?: string;
  worktreeId?: string;
  agentCapabilities: string[];
}) {
  const t = useTranslations("commands");
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [started, setStarted] = useState<Record<string, string>>({});
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

  const run = async (command: CommandDefinition) => {
    setRunning(command.id);
    try {
      const data = await controlPlaneRequest<{
        startCommandRun: { id: string };
      }>(
        "mutation RunCommandQuickAction($input: StartCommandRunInput!) { startCommandRun(input: $input) { id } }",
        {
          input: {
            commandId: command.id,
            origin: "QUICK_ACTION",
            ...(agentId ? { agentId } : { worktreeId }),
          },
        },
      );
      setStarted((current) => ({
        ...current,
        [command.id]: data.startCommandRun.id,
      }));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setRunning(null);
    }
  };

  if (!commands.length && !error) return null;
  return (
    <div
      className="w-full space-y-2"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap gap-2">
        {commands.map((command) => {
          const runId = started[command.id];
          return (
            <div className="flex" key={command.id}>
              {runId && (
                <Button
                  asChild
                  className="rounded-r-none"
                  size="sm"
                  variant="outline"
                >
                  <Link href={`/commands/runs/${runId}`}>
                    <Spinner />
                    {t("view")}
                  </Link>
                </Button>
              )}
              <Button
                className={runId ? "-ml-px rounded-l-none" : undefined}
                disabled={!upgraded || running !== null}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void run(command);
                }}
                size="sm"
                title={
                  !upgraded
                    ? t("upgradeAgentTitle")
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
                {running === command.id ? (
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
