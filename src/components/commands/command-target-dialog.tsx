"use client";

import { HardDrive, Laptop, Play } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CommandAgent, CommandDefinition, CommandWorktree } from "./types";

export function CommandTargetDialog({
  command,
  agents,
  worktrees,
  open,
  onOpenChange,
  onSelect,
}: {
  command: CommandDefinition | null;
  agents: CommandAgent[];
  worktrees: CommandWorktree[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (target: { agentId?: string; worktreeId?: string }) => void;
}) {
  const t = useTranslations("commands");
  const home = command?.targetKind.includes("AGENT_HOME") ?? false;
  const options = home
    ? agents.filter((agent) =>
        command?.targetKind === "SPECIFIC_AGENT_HOME"
          ? agent.id === command.targetAgentId
          : true,
      )
    : worktrees.filter((worktree) =>
        command?.targetKind === "REPOSITORY_WORKTREE"
          ? Boolean(
              worktree.repositoryId &&
              command.targetRepositoryIds.includes(worktree.repositoryId),
            )
          : true,
      );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("runCommand", { name: command?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {t(home ? "chooseAgentTarget" : "chooseWorktreeTarget")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {options.map((option) => {
            const agent = home ? (option as CommandAgent) : null;
            const worktree = home ? null : (option as CommandWorktree);
            const upgraded = agent
              ? agent.capabilities.includes("command.run")
              : agents
                  .find((candidate) => candidate.id === worktree?.agentId)
                  ?.capabilities.includes("command.run") === true;
            return (
              <Button
                className="h-auto w-full min-w-0 items-start justify-start gap-3 py-3 text-left whitespace-normal"
                disabled={!upgraded}
                key={option.id}
                onClick={() =>
                  onSelect(
                    home ? { agentId: option.id } : { worktreeId: option.id },
                  )
                }
                variant="outline"
              >
                {home ? <Laptop /> : <HardDrive />}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block font-medium">
                    {home
                      ? `${agent?.name} · ${agent?.hostname}`
                      : worktree?.branch || worktree?.folder}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {home
                      ? agent?.connectionStatus
                      : `${worktree?.repositoryName} · ${worktree?.agentName} · ${worktree?.folder}`}
                  </span>
                </span>
                {!upgraded ? (
                  <Badge variant="secondary">{t("upgradeAgent")}</Badge>
                ) : (
                  <Play />
                )}
              </Button>
            );
          })}
          {options.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("noEligibleTargets")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
