"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  controlPlaneRequest,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";

import { ActivityRows } from "./activity-rows";
import { RUN_EVENT_FIELDS, RUN_SUBAGENT_FIELDS } from "./graphql-fields";
import { MarkdownView } from "./markdown-view";
import type {
  RunEventView,
  RunSubagentMessagePageView,
  RunSubagentView,
} from "./types";

type Transcript = {
  events: RunEventView[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  retryBefore: string | null;
};

function emptyTranscript(): Transcript {
  return {
    events: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    loadingOlder: false,
    error: null,
    retryBefore: null,
  };
}

function mergeEvents(current: RunEventView[], incoming: RunEventView[]) {
  return [
    ...new Map(
      [...current, ...incoming].map((event) => [event.id, event]),
    ).values(),
  ].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.sequence - b.sequence ||
      a.id.localeCompare(b.id),
  );
}

function RunAgentsContents({
  runId,
  refreshKey,
}: {
  runId: string;
  refreshKey: number;
}) {
  const t = useTranslations("runs");
  const common = useTranslations("common");
  const [agents, setAgents] = useState<RunSubagentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const expandedRef = useRef<string[]>([]);
  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>(
    {},
  );
  const transcriptsRef = useRef<Record<string, Transcript>>({});
  const requests = useRef(new Map<string, AbortController>());
  const disposed = useRef(false);
  const owner = useRef<RefreshCoalescer | null>(null);
  const previousRefreshKey = useRef(refreshKey);

  const updateTranscript = useCallback(
    (id: string, update: (current: Transcript) => Transcript) => {
      const next = {
        ...transcriptsRef.current,
        [id]: update(transcriptsRef.current[id] ?? emptyTranscript()),
      };
      transcriptsRef.current = next;
      setTranscripts(next);
    },
    [],
  );

  const loadMessages = useCallback(
    async (id: string, before: string | null = null) => {
      const requestKey = `${id}:${before ? "older" : "latest"}`;
      requests.current.get(requestKey)?.abort();
      const controller = new AbortController();
      requests.current.set(requestKey, controller);
      updateTranscript(id, (current) => ({
        ...current,
        loading: before ? current.loading : true,
        loadingOlder: before ? true : current.loadingOlder,
        error: null,
      }));
      try {
        const fetchPage = async (cursor: string | null) => {
          const data = await controlPlaneRequest<{
            runSubagentMessages: RunSubagentMessagePageView;
          }>(
            `query RunSubagentMessages($runId: ID!, $subagentId: ID!, $before: ID, $first: Int!) { runSubagentMessages(runId: $runId, subagentId: $subagentId, before: $before, first: $first) { events { ${RUN_EVENT_FIELDS} } nextCursor } }`,
            { runId, subagentId: id, before: cursor, first: 200 },
            { signal: controller.signal },
          );
          return data.runSubagentMessages;
        };
        const knownIds = new Set(
          (transcriptsRef.current[id]?.events ?? []).map((event) => event.id),
        );
        const page = await fetchPage(before);
        const incoming = [...page.events];
        // A reconnect can bring more than one page of new messages. Fill the
        // gap back to cached history before joining the latest and older pages.
        let cursor = page.nextCursor;
        const visited = new Set<string>();
        while (
          !before &&
          knownIds.size &&
          cursor &&
          !visited.has(cursor) &&
          !incoming.some((event) => knownIds.has(event.id))
        ) {
          if (controller.signal.aborted || disposed.current) return;
          visited.add(cursor);
          const older = await fetchPage(cursor);
          incoming.push(...older.events);
          cursor = older.nextCursor;
        }
        if (controller.signal.aborted || disposed.current) return;
        updateTranscript(id, (current) => ({
          ...current,
          events: mergeEvents(current.events, incoming),
          // Refreshing the latest page must preserve the older history already
          // loaded and its cursor, including a null cursor for complete history.
          nextCursor:
            before || !current.events.length
              ? page.nextCursor
              : current.nextCursor,
          loaded: true,
          error: null,
        }));
      } catch (value) {
        if (!controller.signal.aborted && !disposed.current)
          updateTranscript(id, (current) => ({
            ...current,
            error: value instanceof Error ? value.message : String(value),
            retryBefore: before,
          }));
      } finally {
        if (requests.current.get(requestKey) === controller) {
          requests.current.delete(requestKey);
          if (!disposed.current)
            updateTranscript(id, (current) => ({
              ...current,
              loading: before ? current.loading : false,
              loadingOlder: before ? false : current.loadingOlder,
            }));
        }
      }
    },
    [runId, updateTranscript],
  );

  const fetchAgents = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await controlPlaneRequest<{
          runSubagents: RunSubagentView[];
        }>(
          `query RunSubagents($runId: ID!) { runSubagents(runId: $runId) { ${RUN_SUBAGENT_FIELDS} } }`,
          { runId },
          { signal },
        );
        if (signal.aborted) return;
        setAgents(data.runSubagents);
        setError(null);
        await Promise.all(
          expandedRef.current
            .filter((id) => data.runSubagents.some((agent) => agent.id === id))
            .map((id) => loadMessages(id)),
        );
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      }
    },
    [loadMessages, runId],
  );

  useEffect(() => {
    disposed.current = false;
    const refreshOwner = createRefreshCoalescer(fetchAgents);
    owner.current = refreshOwner;
    const timer = window.setTimeout(() => void refreshOwner.refresh(), 0);
    const recover = () => {
      if (document.visibilityState !== "hidden") void refreshOwner.refresh();
    };
    const recovery = onControlPlaneRecovery(recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    const activeRequests = requests.current;
    return () => {
      disposed.current = true;
      window.clearTimeout(timer);
      refreshOwner.dispose();
      recovery();
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
      for (const request of activeRequests.values()) request.abort();
      activeRequests.clear();
      if (owner.current === refreshOwner) owner.current = null;
    };
  }, [fetchAgents]);

  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void owner.current?.refresh();
  }, [refreshKey]);

  if (!agents.length && !error) return null;

  return (
    <Card className="min-w-0" data-testid="run-agents-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("agents.title")}
          <Badge variant="secondary">{agents.length}</Badge>
        </CardTitle>
        <CardDescription>{t("agents.description")}</CardDescription>
      </CardHeader>
      <CardContent className="@container min-w-0 space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription className="space-y-2">
              <p>{error}</p>
              <Button
                onClick={() => void owner.current?.refresh()}
                size="xs"
                variant="outline"
              >
                {t("agents.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <Accordion
          onValueChange={(value) => {
            expandedRef.current = value;
            setExpanded(value);
            for (const id of value) {
              const transcript = transcriptsRef.current[id];
              if (!transcript?.loaded && !transcript?.loading)
                void loadMessages(id);
            }
          }}
          type="multiple"
          value={expanded}
        >
          {agents.map((agent, index) => {
            const transcript = transcripts[agent.id] ?? emptyTranscript();
            const parent = agent.parentNativeId
              ? agents.find(
                  (candidate) =>
                    candidate.nativeId === agent.parentNativeId &&
                    candidate.attemptId === agent.attemptId,
                )
              : null;
            const status = t.has(`agents.status.${agent.status}`)
              ? agent.status
              : "UNKNOWN";
            return (
              <AccordionItem
                className="min-w-0"
                key={agent.id}
                value={agent.id}
              >
                <AccordionTrigger className="min-w-0 items-start gap-3 py-3 hover:no-underline [&>[data-slot=accordion-trigger-icon]]:mt-0.5">
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5 @lg:flex-row @lg:items-start @lg:gap-4">
                    <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                      {agent.label ||
                        t("agents.fallbackLabel", { number: index + 1 })}
                      {agent.parentNativeId && (
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {t("agents.spawnedBy", {
                            name: parent?.label || agent.parentNativeId,
                          })}
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-normal @lg:shrink-0 @lg:justify-end">
                      {agent.agentType && (
                        <span className="text-xs text-muted-foreground">
                          {agent.agentType}
                        </span>
                      )}
                      <Badge className="shrink-0" variant="outline">
                        {t(`agents.status.${status}`)}
                      </Badge>
                      {agent.startedAt && (
                        <DateTime
                          className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @lg:ml-0"
                          hover={false}
                          kind="time"
                          value={agent.startedAt}
                        />
                      )}
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="h-auto min-w-0 space-y-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {t("agents.messageCount", { count: agent.messageCount })}
                    </span>
                    {agent.startedAt && (
                      <span>
                        {t("info.startedAt")}:{" "}
                        <DateTime kind="time" value={agent.startedAt} />
                      </span>
                    )}
                    {agent.finishedAt && (
                      <span>
                        {t("info.finishedAt")}:{" "}
                        <DateTime kind="time" value={agent.finishedAt} />
                      </span>
                    )}
                  </div>
                  {agent.prompt && (
                    <div className="space-y-2">
                      <h3 className="font-medium">{t("prompt")}</h3>
                      <MarkdownView showActions={false} value={agent.prompt} />
                    </div>
                  )}
                  {agent.finalOutput && (
                    <div className="space-y-2">
                      <h3 className="font-medium">{t("summary")}</h3>
                      <MarkdownView
                        showActions={false}
                        value={agent.finalOutput}
                      />
                    </div>
                  )}
                  {agent.transcriptStatus !== "AVAILABLE" && (
                    <p className="break-words text-sm text-muted-foreground">
                      {agent.transcriptStatus === "PARTIAL"
                        ? t("agents.partialTranscript")
                        : t("agents.unavailableTranscript")}
                    </p>
                  )}
                  {agent.transcriptError && (
                    <p className="break-words text-xs text-muted-foreground">
                      {agent.transcriptError}
                    </p>
                  )}
                  {transcript.error && (
                    <Alert variant="destructive">
                      <AlertDescription className="space-y-2">
                        <p>{transcript.error}</p>
                        <Button
                          onClick={() =>
                            void loadMessages(agent.id, transcript.retryBefore)
                          }
                          size="xs"
                          variant="outline"
                        >
                          {t("agents.retry")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  {transcript.loading && !transcript.loaded ? (
                    <div
                      aria-label={t("agents.loadingTranscript")}
                      role="status"
                    >
                      <Spinner />
                    </div>
                  ) : transcript.loaded && transcript.events.length > 0 ? (
                    <div className="min-w-0 overflow-hidden rounded-md border">
                      {transcript.nextCursor && (
                        <Button
                          disabled={transcript.loadingOlder}
                          onClick={() =>
                            void loadMessages(agent.id, transcript.nextCursor)
                          }
                          size="sm"
                          variant="ghost"
                        >
                          {transcript.loadingOlder && <Spinner />}
                          {common("loadMore")}
                        </Button>
                      )}
                      <div className="max-h-[24rem] overflow-y-auto">
                        <Table className="table-fixed">
                          <TableHeader className="sticky top-0 z-10 bg-card">
                            <TableRow>
                              <TableHead className="h-7 w-10" />
                              <TableHead className="h-7">
                                {t("activity")}
                              </TableHead>
                              <TableHead className="h-7 w-40">
                                {t("status")}
                              </TableHead>
                              <TableHead className="h-7 w-24">
                                {t("age")}
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <ActivityRows events={transcript.events} />
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  ) : transcript.loaded &&
                    agent.transcriptStatus === "AVAILABLE" ? (
                    <p className="text-sm text-muted-foreground">
                      {t("noActivity")}
                    </p>
                  ) : null}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </CardContent>
    </Card>
  );
}

export function RunAgentsCard(props: { runId: string; refreshKey: number }) {
  // Navigation gets an isolated cache and aborts every read from the old run.
  return <RunAgentsContents key={props.runId} {...props} />;
}
