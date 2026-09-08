"use client";

import { Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { commandStatusKey, commandTargetKey } from "./types";
import {
  useCommandTargetSummary,
  type CommandActionDefinition,
} from "./command-target-summaries";

export function CommandResourcePanel({
  agentId,
  worktreeId,
  agentCapabilities,
}: {
  agentId?: string;
  worktreeId?: string;
  agentCapabilities: string[];
}) {
  const t = useTranslations("commands");
  const router = useRouter();
  const summary = useCommandTargetSummary(
    {
      resourceKind: agentId ? "AGENT" : "WORKTREE",
      resourceId: agentId ?? worktreeId ?? "",
    },
    { includeAllCommands: true, includeRecentRuns: true },
  );
  const commands = summary.commands;
  const runs = summary.recentRuns;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upgraded = agentCapabilities.includes("command.run");
  const run = async (command: CommandActionDefinition) => {
    setBusy(command.id);
    try {
      const data = await controlPlaneRequest<{
        startCommandRun: { id: string };
      }>(
        "mutation StartResourceCommand($input: StartCommandRunInput!) { startCommandRun(input: $input) { id } }",
        {
          input: {
            commandId: command.id,
            origin: "MANUAL",
            ...(agentId ? { agentId } : { worktreeId }),
          },
        },
      );
      router.push(`/commands/runs/${data.startCommandRun.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };
  const displayedError = error ?? summary.error;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>
              {t(
                agentId
                  ? "resourceDescriptionAgent"
                  : "resourceDescriptionWorktree",
              )}
            </CardDescription>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/commands">{t("manage")}</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {displayedError && (
          <Alert variant="destructive">
            <AlertDescription>{displayedError}</AlertDescription>
          </Alert>
        )}
        {!upgraded && (
          <Alert>
            <AlertDescription>{t("upgradeAgentDescription")}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          {commands.map((command) => (
            <Button
              className="h-auto justify-start py-3 text-left"
              disabled={!upgraded || busy !== null}
              key={command.id}
              onClick={() => void run(command)}
              variant="outline"
            >
              <Play />
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {command.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {command.description ||
                    t(commandTargetKey(command.targetKind))}
                </span>
              </span>
            </Button>
          ))}
          {commands.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("noEligibleCommands")}
            </p>
          )}
        </div>
        {runs.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("recentRuns")}</h3>
            {runs.map((run) => (
              <Link
                className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
                href={`/commands/runs/${run.id}`}
                key={run.id}
              >
                <span className="font-mono text-xs">#{run.displayNumber}</span>
                <span className="min-w-0 flex-1 truncate">
                  {run.snapshotName}
                </span>
                <Badge variant="outline">
                  {t(commandStatusKey(run.status))}
                </Badge>
                <DateTime
                  className="hidden text-xs text-muted-foreground sm:block"
                  value={run.createdAt}
                />
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
