"use client";

import {
  ArrowLeft,
  Check,
  CircleStop,
  Copy,
  ExternalLink,
  FilePenLine,
  RotateCcw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { DetailItem, DetailList } from "@/components/common/detail-list";
import {
  decodeTerminalBase64,
  TerminalOutputCard,
} from "@/components/common/terminal-output-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, useRouter } from "@/i18n/navigation";
import { useNow } from "@/hooks/use-now";
import { copyText } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";

import {
  COMMAND_RUN_FIELDS,
  activeCommandRun,
  commandOriginKey,
  commandRestartKey,
  commandStatusKey,
  type CommandRun,
} from "./types";

type OutputChunk = {
  id: string;
  attemptId: string;
  attemptNumber: number;
  sequence: number;
  stream: string;
  dataBase64: string;
  byteLength: number;
  createdAt: string;
};
const OUTPUT_FIELDS =
  "id attemptId attemptNumber sequence stream dataBase64 byteLength createdAt";
const EMPTY_OUTPUT: OutputChunk[] = [];

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  return `${seconds}s`;
}

function LiveRunDuration({ startedAt }: { startedAt: string }) {
  const start = Date.parse(startedAt);
  const now = useNow(Number.isFinite(start) ? start : null);
  if (!Number.isFinite(start) || now === null) return <>—</>;
  return <>{formatDuration(now - start)}</>;
}

function RunDuration({
  startedAt,
  finishedAt,
}: {
  startedAt: string | null;
  finishedAt: string | null;
}) {
  if (!startedAt) return <>—</>;
  if (!finishedAt) return <LiveRunDuration startedAt={startedAt} />;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return <>—</>;
  return <>{formatDuration(finish - start)}</>;
}

function mergeOutputChunks(
  current: OutputChunk[],
  incoming: OutputChunk[],
): OutputChunk[] {
  const chunks = new Map(current.map((chunk) => [chunk.id, chunk]));
  for (const chunk of incoming) chunks.set(chunk.id, chunk);
  return [...chunks.values()].sort(
    (left, right) =>
      left.attemptNumber - right.attemptNumber ||
      left.sequence - right.sequence ||
      left.id.localeCompare(right.id),
  );
}

export function CommandRunPage({ runId }: { runId: string }) {
  const t = useTranslations("commands");
  const router = useRouter();
  const [run, setRun] = useState<CommandRun | null>(null);
  const [outputState, setOutputState] = useState<{
    runId: string;
    chunks: OutputChunk[];
  }>({ runId, chunks: [] });
  const output =
    outputState.runId === runId ? outputState.chunks : EMPTY_OUTPUT;
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [snapshotCopied, setSnapshotCopied] = useState(false);

  const loadRun = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{ commandRun: CommandRun | null }>(
        `query CommandRunDetail($id: ID!) { commandRun(id: $id) { ${COMMAND_RUN_FIELDS} predecessor { id displayNumber } successor { id displayNumber } } }`,
        { id: runId },
      );
      setRun(data.commandRun);
      setError(data.commandRun ? null : t("runNotFound"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [runId, t]);

  useEffect(() => {
    let cancelled = false;
    let hydrating = true;
    let buffered: OutputChunk[] = [];
    const dispose = controlPlaneSubscriptions().subscribe<{
      commandRunOutputAdded: OutputChunk;
    }>(
      {
        query: `subscription CommandOutput($runId: ID!) { commandRunOutputAdded(runId: $runId) { ${OUTPUT_FIELDS} } }`,
        variables: { runId },
      },
      {
        next: (result) => {
          const chunk = result.data?.commandRunOutputAdded;
          if (!chunk) return;
          if (hydrating) buffered.push(chunk);
          else
            setOutputState((current) => ({
              runId,
              chunks: mergeOutputChunks(
                current.runId === runId ? current.chunks : [],
                [chunk],
              ),
            }));
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    void (async () => {
      const historical: OutputChunk[] = [];
      let afterAttempt = 0;
      let afterSequence = -1;
      while (!cancelled) {
        const { commandRunOutput } = await controlPlaneRequest<{
          commandRunOutput: OutputChunk[];
        }>(
          `query CommandOutput($runId: ID!, $afterAttempt: Int!, $afterSequence: Int!) {
            commandRunOutput(runId: $runId, afterAttempt: $afterAttempt, afterSequence: $afterSequence, first: 1000) { ${OUTPUT_FIELDS} }
          }`,
          { runId, afterAttempt, afterSequence },
        );
        historical.push(...commandRunOutput);
        if (commandRunOutput.length < 1_000) break;
        const last = commandRunOutput.at(-1);
        if (!last) break;
        afterAttempt = last.attemptNumber;
        afterSequence = last.sequence;
      }
      if (cancelled) return;
      hydrating = false;
      setOutputState({
        runId,
        chunks: mergeOutputChunks(historical, buffered),
      });
      buffered = [];
    })().catch((value) => {
      if (!cancelled) {
        hydrating = false;
        setOutputState((current) => ({
          runId,
          chunks: mergeOutputChunks(
            current.runId === runId ? current.chunks : [],
            buffered,
          ),
        }));
        buffered = [];
        setError(value instanceof Error ? value.message : String(value));
      }
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [runId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadRun(), 0);
    const client = controlPlaneSubscriptions();
    const disposeRun = client.subscribe(
      {
        query:
          "subscription CommandRunStatus($runId: ID!) { commandRunChanged(runId: $runId) { id status updatedAt } }",
        variables: { runId },
      },
      {
        next: () => void loadRun(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initialLoad);
      disposeRun();
    };
  }, [loadRun, runId]);

  const mutate = async (kind: "terminate" | "rerun") => {
    setMutating(true);
    try {
      if (kind === "terminate") {
        await controlPlaneRequest(
          "mutation TerminateCommandRun($id: ID!) { terminateCommandRun(id: $id) { id status } }",
          { id: runId },
        );
        await loadRun();
      } else {
        const data = await controlPlaneRequest<{
          rerunCommandRun: { id: string };
        }>(
          "mutation RerunCommandRun($id: ID!) { rerunCommandRun(id: $id) { id } }",
          { id: runId },
        );
        router.push(`/commands/runs/${data.rerunCommandRun.id}`);
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setMutating(false);
    }
  };

  const copySnapshot = async (snapshotScript: string) => {
    try {
      await copyText(snapshotScript);
      setSnapshotCopied(true);
    } catch {
      setError(t("copyFailed"));
    }
  };

  const terminalEntries = useMemo(
    () =>
      output.map((chunk) => ({
        id: chunk.id,
        data: decodeTerminalBase64(chunk.dataBase64),
        divider: t("attemptDivider", { number: chunk.attemptNumber }),
        dividerKey: String(chunk.attemptNumber),
      })),
    [output, t],
  );

  if (!run && !error) return <Card className="h-96 animate-pulse" />;
  if (!run)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  const highlighted = run.worktree?.highlightColor;

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "flex flex-wrap items-center gap-3",
          highlighted && "rounded-lg border-l-4 p-4",
          highlighted && worktreeHighlightBackgroundClasses[highlighted],
          highlighted && worktreeHighlightAccentClasses[highlighted],
        )}
        data-testid="command-run-summary"
      >
        <Button asChild size="icon" variant="ghost">
          <Link href="/commands">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="mr-auto">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{run.snapshotName}</h1>
            <Badge
              variant={
                run.status === "SUCCEEDED"
                  ? "default"
                  : run.status === "FAILED"
                    ? "destructive"
                    : "secondary"
              }
            >
              {t(commandStatusKey(run.status))}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("runNumber", { number: run.displayNumber })} ·{" "}
            {t(commandOriginKey(run.origin))}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/commands/${run.commandId}/edit`}>
            <FilePenLine />
            {t("editCommand")}
          </Link>
        </Button>
        <Button
          disabled={mutating}
          variant="outline"
          onClick={() => void mutate("rerun")}
        >
          <RotateCcw />
          {t("rerun")}
        </Button>
        {activeCommandRun(run.status) && (
          <Button
            disabled={mutating}
            variant="destructive"
            onClick={() => void mutate("terminate")}
          >
            <CircleStop />
            {t("terminate")}
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {run.error && (
        <Alert variant="destructive">
          <AlertTitle>{t("runError")}</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("overview")}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailList className="sm:grid-cols-6">
            <DetailItem className="sm:col-span-3" label={t("agent")}>
              {run.agentId ? (
                <Button
                  asChild
                  className="h-auto w-full min-w-0 items-start justify-start px-0 text-left whitespace-normal"
                  variant="link"
                >
                  <Link href={`/agents/${run.agentId}`}>
                    <span className="min-w-0 break-words">{run.agentName}</span>
                    <ExternalLink />
                  </Link>
                </Button>
              ) : (
                <p className="break-words">{run.agentName}</p>
              )}
              <p className="break-words text-xs text-muted-foreground">
                {run.agentHostname}
              </p>
            </DetailItem>
            <DetailItem className="sm:col-span-3" label={t("worktree")}>
              {run.worktreeId ? (
                <Button
                  asChild
                  className="h-auto w-full min-w-0 items-start justify-start px-0 text-left whitespace-normal"
                  variant="link"
                >
                  <Link href={`/worktrees/${run.worktreeId}`}>
                    <span className="min-w-0 break-words">
                      {run.worktreeBranch || run.worktreePath}
                    </span>
                    <ExternalLink />
                  </Link>
                </Button>
              ) : run.snapshotTargetKind.includes("WORKTREE") ? (
                <p className="break-words">
                  {run.worktreeBranch ||
                    run.worktreePath ||
                    t("targetUnavailable")}
                </p>
              ) : (
                <p>{t("agentHome")}</p>
              )}
            </DetailItem>
            <DetailItem className="sm:col-span-2" label={t("restart")}>
              <p>
                {t(commandRestartKey(run.snapshotRestartPolicy))}
                {run.snapshotRestartPolicy !== "NEVER" && (
                  <>
                    {" · "}
                    {run.restartCount}/{run.snapshotRestartLimit ?? "∞"}
                  </>
                )}
              </p>
              {run.nextRestartAt && (
                <p className="text-xs text-muted-foreground">
                  {t("nextRestart")} <DateTime value={run.nextRestartAt} />
                </p>
              )}
            </DetailItem>
            <DetailItem className="sm:col-span-2" label={t("started")}>
              <DateTime value={run.startedAt} />
            </DetailItem>
            <DetailItem className="sm:col-span-2" label={t("duration")}>
              <RunDuration
                finishedAt={run.finishedAt}
                startedAt={run.startedAt}
              />
            </DetailItem>
          </DetailList>
        </CardContent>
      </Card>
      <TerminalOutputCard
        ariaLabel={t("terminalOutput")}
        emptyText={t("noOutput")}
        entries={terminalEntries}
        fitLabel={t("fitTerminal")}
        followLabel={t("followOutput")}
        sourceKey={runId}
        title={t("terminalOutput")}
      />
      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle>{t("attempts")}</CardTitle>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead>{t("started")}</TableHead>
              <TableHead>{t("finished")}</TableHead>
              <TableHead>{t("result")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.attempts.map((attempt) => (
              <TableRow key={attempt.id}>
                <TableCell>{attempt.attempt}</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {t(commandStatusKey(attempt.status))}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DateTime value={attempt.startedAt} />
                </TableCell>
                <TableCell>
                  <DateTime value={attempt.finishedAt} />
                </TableCell>
                <TableCell>
                  {attempt.exitCode !== null
                    ? t("exitCode", { code: attempt.exitCode })
                    : attempt.signal || attempt.error || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("snapshot")}</CardTitle>
          <CardAction>
            <Button
              onClick={() => void copySnapshot(run.snapshotScript)}
              size="sm"
              type="button"
              variant="outline"
            >
              {snapshotCopied ? <Check /> : <Copy />}
              {snapshotCopied ? t("commandCopied") : t("copyCommand")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-xs">
            {run.snapshotScript}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
