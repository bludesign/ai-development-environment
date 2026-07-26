"use client";

import { HardDrive, Laptop, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { CommandAgent, CommandWorktree } from "./types";

type CustomCommandTarget = { agentId: string } | { worktreeId: string };

export function CustomCommandDialog({
  agents,
  worktrees,
  open,
  submitting,
  onOpenChange,
  onSubmit,
}: {
  agents: CommandAgent[];
  worktrees: CommandWorktree[];
  open: boolean;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (script: string, target: CustomCommandTarget) => void;
}) {
  const t = useTranslations("commands");
  const [script, setScript] = useState("");
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const targets = useMemo(
    () => [
      ...agents.map((agent) => ({
        key: `agent:${agent.id}`,
        id: agent.id,
        kind: "AGENT" as const,
        title: `${agent.name} · ${agent.hostname}`,
        detail: agent.connectionStatus,
        upgraded: agent.capabilities.includes("command.run"),
      })),
      ...worktrees.map((worktree) => ({
        key: `worktree:${worktree.id}`,
        id: worktree.id,
        kind: "WORKTREE" as const,
        title: worktree.branch || worktree.folder,
        detail: `${worktree.repositoryName} · ${worktree.agentName} · ${worktree.folder}`,
        upgraded:
          agents
            .find((agent) => agent.id === worktree.agentId)
            ?.capabilities.includes("command.run") === true,
      })),
    ],
    [agents, worktrees],
  );
  const selected = targets.find((target) => target.key === targetKey) ?? null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("runCustom")}</DialogTitle>
          <DialogDescription>{t("customCommandDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="custom-command-script">{t("script")}</Label>
            <Textarea
              autoFocus
              className="min-h-32 font-mono"
              id="custom-command-script"
              onChange={(event) => setScript(event.target.value)}
              placeholder={t("customCommandPlaceholder")}
              value={script}
            />
            <p className="text-xs text-muted-foreground">
              {t("customCommandWarning")}
            </p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("runIn")}</legend>
            <div className="grid gap-2">
              {targets.map((target) => (
                <Button
                  aria-pressed={targetKey === target.key}
                  className={cn(
                    "h-auto w-full min-w-0 items-start justify-start gap-3 py-3 text-left whitespace-normal",
                    targetKey === target.key && "ring-2 ring-ring",
                  )}
                  disabled={!target.upgraded || submitting}
                  key={target.key}
                  onClick={() => setTargetKey(target.key)}
                  type="button"
                  variant="outline"
                >
                  {target.kind === "AGENT" ? <Laptop /> : <HardDrive />}
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className="block font-medium">{target.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {target.detail}
                    </span>
                  </span>
                  {!target.upgraded && (
                    <Badge variant="secondary">{t("upgradeAgent")}</Badge>
                  )}
                </Button>
              ))}
              {targets.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("noEligibleTargets")}
                </p>
              )}
            </div>
          </fieldset>
        </div>
        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={!script.trim() || !selected || submitting}
            onClick={() => {
              if (!selected) return;
              onSubmit(
                script,
                selected.kind === "AGENT"
                  ? { agentId: selected.id }
                  : { worktreeId: selected.id },
              );
            }}
            type="button"
          >
            <Play />
            {submitting ? t("running") : t("run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
