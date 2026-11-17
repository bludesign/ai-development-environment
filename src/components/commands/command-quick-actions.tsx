"use client";

import { CircleStop, ExternalLink, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ConfigurationIcon } from "@/components/builds/configuration-icon";
import { TailscaleEndpointCopy } from "@/components/tailscale/tailscale-endpoint-copy";
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
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { TailscaleAddress } from "@/lib/tailscale-addresses";
import { cn } from "@/lib/utils";

import { activeCommandRun } from "./types";
import { useCommandPortConflict } from "./command-port-conflict";
import {
  useCommandTargetSummary,
  type CommandActionDefinition,
} from "./command-target-summaries";

type ActiveRun = {
  id: string;
  displayNumber: number;
  status: string;
  tailscaleAddresses: TailscaleAddress[];
};

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
  const summary = useCommandTargetSummary({
    resourceKind: agentId ? "AGENT" : "WORKTREE",
    resourceId: agentId ?? worktreeId ?? "",
  });
  const commands = summary.commands.filter(
    (command) => command.quickActionEnabled,
  );
  const [starting, setStarting] = useState<string | null>(null);
  const conflict = useCommandPortConflict();
  const active: Record<string, ActiveRun[]> = {};
  for (const run of summary.activeRuns) {
    if (activeCommandRun(run.status)) (active[run.commandId] ??= []).push(run);
  }
  const [error, setError] = useState<string | null>(null);
  const upgraded = agentCapabilities.includes("command.run");

  const mutate = async (query: string, variables: Record<string, unknown>) => {
    try {
      await controlPlaneRequest(query, variables);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      summary.refresh();
    }
  };

  const start = async (command: CommandActionDefinition) => {
    setStarting(command.id);
    setError(null);
    const idempotencyKey = command.port == null ? undefined : createClientId();
    await conflict.submit(async (portConflictResolution) => {
      await controlPlaneRequest(
        "mutation RunCommandQuickAction($input: StartCommandRunInput!) { startCommandRun(input: $input) { id } }",
        {
          input: {
            commandId: command.id,
            origin: "QUICK_ACTION",
            ...(idempotencyKey ? { idempotencyKey } : {}),
            ...(portConflictResolution ? { portConflictResolution } : {}),
            ...(agentId ? { agentId } : { worktreeId }),
          },
        },
      );
      summary.refresh();
    }, setError);
    setStarting(null);
  };

  const terminate = (runId: string) =>
    mutate(
      "mutation TerminateQuickActionRun($id: ID!) { terminateCommandRun(id: $id) { id } }",
      { id: runId },
    );

  // Rerun terminates a run that is still going and starts its successor once
  // the original stops, which is exactly the restart this menu offers.
  const restart = async (runId: string) => {
    setError(null);
    await conflict.submit(async (portConflictResolution) => {
      await controlPlaneRequest(
        "mutation RestartQuickActionRun($id: ID!, $portConflictResolution: CommandPortConflictResolutionInput) { rerunCommandRun(id: $id, portConflictResolution: $portConflictResolution) { id } }",
        {
          id: runId,
          ...(portConflictResolution ? { portConflictResolution } : {}),
        },
      );
      summary.refresh();
    }, setError);
  };

  const displayedError = error ?? summary.error;
  if (!commands.length && !displayedError) return null;
  const actions = (
    <div
      className={cn("w-full space-y-2", className)}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap gap-2">
        {commands.map((command) => {
          const runs = active[command.id] ?? [];
          const addresses = [
            ...new Map(
              [
                ...(command.tailscaleAddresses ?? []),
                ...runs.flatMap((run) => run.tailscaleAddresses ?? []),
              ].map((address) => [address.url ?? address.endpoint, address]),
            ).values(),
          ];
          const hasMenu = runs.length > 0 || addresses.length > 0;
          const busy = runs.length > 0 || starting === command.id;
          return (
            <div className="flex" key={command.id}>
              {hasMenu && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={t(
                        runs.length ? "manageRuns" : "openPortAddressesNamed",
                        { name: command.name },
                      )}
                      className="rounded-r-none"
                      size="sm"
                      variant="outline"
                    >
                      {runs.length > 0 ? <Spinner /> : <ExternalLink />}
                      {runs.length > 1 && (
                        <span className="text-xs tabular-nums">
                          {runs.length}
                        </span>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className={
                      addresses.length > 0
                        ? "w-max max-w-[min(26rem,calc(100vw_-_2rem))]"
                        : "min-w-48"
                    }
                  >
                    {addresses.length > 0 && (
                      <>
                        <DropdownMenuLabel>
                          {t("tailscaleAddresses")}
                        </DropdownMenuLabel>
                        {addresses.map((address) =>
                          address.url ? (
                            <DropdownMenuItem asChild key={address.url}>
                              <a
                                href={address.url}
                                rel="noreferrer"
                                target="_blank"
                              >
                                <ExternalLink />
                                <span className="min-w-0 break-all">
                                  {address.kind} · {address.url}
                                </span>
                              </a>
                            </DropdownMenuItem>
                          ) : (
                            <TailscaleEndpointCopy
                              address={address}
                              key={address.endpoint}
                              menuItem
                            />
                          ),
                        )}
                        {runs.length > 0 && <DropdownMenuSeparator />}
                      </>
                    )}
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
                        <DropdownMenuItem
                          disabled={conflict.pending}
                          onSelect={() => void restart(run.id)}
                        >
                          <RotateCcw />
                          {t("restartRun")}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/dashboard/commands/runs/${run.id}`}>
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
                className={hasMenu ? "-ml-px rounded-l-none" : undefined}
                disabled={!upgraded || starting !== null || conflict.pending}
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
      {displayedError && (
        <Alert variant="destructive">
          <AlertDescription>{displayedError}</AlertDescription>
        </Alert>
      )}
      {conflict.dialog}
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
      <Link href={`/dashboard/commands/runs/${id}`}>
        {label}
        <ExternalLink />
      </Link>
    </Button>
  );
}
