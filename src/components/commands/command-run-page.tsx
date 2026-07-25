"use client";

import {
  ArrowLeft,
  Check,
  CircleStop,
  Copy,
  ExternalLink,
  FilePenLine,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
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
import { copyText } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function CommandRunPage({ runId }: { runId: string }) {
  const t = useTranslations("commands");
  const router = useRouter();
  const [terminalElement, setTerminalElement] = useState<HTMLDivElement | null>(
    null,
  );
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const followRef = useRef(true);
  const writtenRef = useRef(new Set<string>());
  const lastAttemptRef = useRef(0);
  const [run, setRun] = useState<CommandRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
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

  const writeChunk = useCallback(
    (chunk: OutputChunk) => {
      const terminal = terminalRef.current;
      if (!terminal || writtenRef.current.has(chunk.id)) return;
      writtenRef.current.add(chunk.id);
      if (chunk.attemptNumber !== lastAttemptRef.current) {
        lastAttemptRef.current = chunk.attemptNumber;
        terminal.write(
          `\r\n\x1b[90m── ${t("attemptDivider", { number: chunk.attemptNumber })} ──\x1b[0m\r\n`,
        );
      }
      terminal.write(decodeBase64(chunk.dataBase64), () => {
        if (followRef.current) terminal.scrollToBottom();
      });
    },
    [t],
  );

  useEffect(() => {
    if (!terminalElement) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let scrollDisposable: { dispose(): void } | null = null;
    writtenRef.current.clear();
    lastAttemptRef.current = 0;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      ([{ Terminal }, { FitAddon }]) => {
        if (cancelled) return;
        const terminal = new Terminal({
          convertEol: true,
          cursorBlink: false,
          disableStdin: true,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          scrollback: 100_000,
          theme: {
            background: "#09090b",
            foreground: "#fafafa",
            cursor: "#a1a1aa",
            selectionBackground: "#3f3f46",
          },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(terminalElement);
        fit.fit();
        terminalRef.current = terminal;
        fitRef.current = fit;
        scrollDisposable = terminal.onScroll(() => {
          const atBottom =
            terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
          followRef.current = atBottom;
          setFollow(atBottom);
        });
        observer = new ResizeObserver(() => fit.fit());
        observer.observe(terminalElement);
        void (async () => {
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
            commandRunOutput.forEach(writeChunk);
            if (commandRunOutput.length < 1_000) return;
            const last = commandRunOutput.at(-1);
            if (!last) return;
            afterAttempt = last.attemptNumber;
            afterSequence = last.sequence;
          }
        })().catch((value) =>
          setError(value instanceof Error ? value.message : String(value)),
        );
      },
    );
    return () => {
      cancelled = true;
      observer?.disconnect();
      scrollDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [runId, terminalElement, writeChunk]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadRun(), 0);
    const client = controlPlaneSubscriptions();
    const disposeOutput = client.subscribe<{
      commandRunOutputAdded: OutputChunk;
    }>(
      {
        query: `subscription CommandOutput($runId: ID!) { commandRunOutputAdded(runId: $runId) { ${OUTPUT_FIELDS} } }`,
        variables: { runId },
      },
      {
        next: (result) => {
          if (result.data?.commandRunOutputAdded)
            writeChunk(result.data.commandRunOutputAdded);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
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
      disposeOutput();
      disposeRun();
    };
  }, [loadRun, runId, writeChunk]);

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

  if (!run && !error) return <Card className="h-96 animate-pulse" />;
  if (!run)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
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
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("agent")}</CardTitle>
          </CardHeader>
          <CardContent>
            {run.agentId ? (
              <Button asChild className="px-0" variant="link">
                <Link href={`/agents/${run.agentId}`}>
                  {run.agentName}
                  <ExternalLink />
                </Link>
              </Button>
            ) : (
              <p>{run.agentName}</p>
            )}
            <p className="text-xs text-muted-foreground">{run.agentHostname}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("worktree")}</CardTitle>
          </CardHeader>
          <CardContent>
            {run.worktreeId ? (
              <Button asChild className="h-auto px-0 text-left" variant="link">
                <Link href={`/worktrees/${run.worktreeId}`}>
                  {run.worktreeBranch || run.worktreePath}
                  <ExternalLink />
                </Link>
              </Button>
            ) : run.snapshotTargetKind.includes("WORKTREE") ? (
              <p>
                {run.worktreeBranch ||
                  run.worktreePath ||
                  t("targetUnavailable")}
              </p>
            ) : (
              <p>{t("agentHome")}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("restart")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              {t(commandRestartKey(run.snapshotRestartPolicy))} ·{" "}
              {run.restartCount}/{run.snapshotRestartLimit ?? "∞"}
            </p>
            {run.nextRestartAt && (
              <p className="text-xs text-muted-foreground">
                {t("nextRestart")} <DateTime value={run.nextRestartAt} />
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("timing")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              <DateTime value={run.startedAt ?? run.queuedAt} />
            </p>
            {run.finishedAt && (
              <p className="text-xs text-muted-foreground">
                {t("finished")} <DateTime value={run.finishedAt} />
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden p-0">
        <CardHeader className="flex grid-cols-none flex-row items-center justify-between gap-3 border-b px-4 py-3">
          <CardTitle className="text-sm">{t("terminalOutput")}</CardTitle>
          <div className="flex items-center gap-2">
            {!follow && (
              <Button
                variant="outline"
                onClick={() => {
                  followRef.current = true;
                  setFollow(true);
                  terminalRef.current?.scrollToBottom();
                }}
              >
                {t("followOutput")}
              </Button>
            )}
            <Button
              aria-label={t("fitTerminal")}
              size="icon"
              variant="outline"
              onClick={() => fitRef.current?.fit()}
            >
              <RefreshCw />
            </Button>
          </div>
        </CardHeader>
        <div
          className="h-[min(60vh,42rem)] bg-[#09090b] p-2"
          ref={setTerminalElement}
        />
      </Card>
      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle className="text-sm">{t("attempts")}</CardTitle>
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
          <CardTitle className="text-sm">{t("snapshot")}</CardTitle>
          <CardAction>
            <Button
              aria-label={
                snapshotCopied ? t("commandCopied") : t("copyCommand")
              }
              onClick={() => void copySnapshot(run.snapshotScript)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              {snapshotCopied ? <Check /> : <Copy />}
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
