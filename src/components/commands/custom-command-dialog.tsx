"use client";

import { HardDrive, Laptop, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { useRouter } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import type { CommandAgent, CommandWorktree } from "./types";

type CustomCommandTarget =
  | { agentId: string; worktreeId?: never }
  | { worktreeId: string; agentId?: never };

type CustomCommandSubmission = CustomCommandTarget & {
  script: string;
  idempotencyKey: string;
};

export function CustomCommandDialog({
  agents,
  worktrees,
  worktreeId,
  onClose,
  onCloseAutoFocus,
}: {
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
} & (
  | { agents: CommandAgent[]; worktrees: CommandWorktree[]; worktreeId?: never }
  | { worktreeId: string; agents?: never; worktrees?: never }
)) {
  const t = useTranslations("commands");
  const router = useRouter();
  const scriptId = useId();
  const [script, setScript] = useState("");
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<CustomCommandSubmission | null>(null);
  const targets = useMemo(() => {
    if (!agents || !worktrees) return [];
    return [
      ...agents.map((agent) => ({
        key: `agent:${agent.id}`,
        input: { agentId: agent.id },
        kind: "AGENT" as const,
        title: `${agent.name} · ${agent.hostname}`,
        detail: agent.connectionStatus,
        upgraded: agent.capabilities.includes("command.run"),
      })),
      ...worktrees.map((worktree) => ({
        key: `worktree:${worktree.id}`,
        input: { worktreeId: worktree.id },
        kind: "WORKTREE" as const,
        title: worktree.branch || worktree.folder,
        detail: `${worktree.repositoryName} · ${worktree.agentName} · ${worktree.folder}`,
        upgraded:
          agents
            .find((agent) => agent.id === worktree.agentId)
            ?.capabilities.includes("command.run") === true,
      })),
    ];
  }, [agents, worktrees]);
  const selected = targets.find((target) => target.key === targetKey);
  const target: CustomCommandTarget | null = worktreeId
    ? { worktreeId }
    : selected?.upgraded
      ? selected.input
      : null;
  const launch = async () => {
    if (!target || !script.trim() || submitting) return;
    const previous = submission.current;
    const input =
      previous?.script === script &&
      previous.agentId === target.agentId &&
      previous.worktreeId === target.worktreeId
        ? previous
        : { script, ...target, idempotencyKey: createClientId() };
    submission.current = input;
    setSubmitting(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        startCustomCommandRun: { id: string };
      }>(
        "mutation StartCustomCommand($input: StartCustomCommandRunInput!) { startCustomCommandRun(input: $input) { id } }",
        { input: { ...input, origin: "MANUAL" } },
      );
      onClose();
      router.push(`/dashboard/commands/runs/${data.startCustomCommandRun.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && !submitting && onClose()} open>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{t("runCustom")}</DialogTitle>
          <DialogDescription>{t("customCommandDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={scriptId}>{t("script")}</Label>
            <Textarea
              autoFocus
              className="min-h-32 font-mono"
              id={scriptId}
              onChange={(event) => setScript(event.target.value)}
              placeholder={t("customCommandPlaceholder")}
              value={script}
            />
            <p className="text-xs text-muted-foreground">
              {t("customCommandWarning")}
            </p>
          </div>
          {!worktreeId && (
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
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={!script.trim() || !target || submitting}
            onClick={() => void launch()}
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
