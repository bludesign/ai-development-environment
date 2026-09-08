"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import { readCursorWindow } from "@/lib/read-cursor-window";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

import {
  ACTION_CENTER_ITEM_FIELDS,
  type ActionCenterItem,
  type ActionCenterPageView,
  type ActionCenterQuestionBatch,
} from "./types";

const PAGE_SIZE = 50;

type AnswerPayload = Record<string, { answers: string[] }>;

type ActionCenterContextValue = {
  items: ActionCenterItem[];
  totalCount: number;
  needsAttentionCount: number;
  activeCount: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  answerQuestion: (
    item: ActionCenterItem,
    batch: ActionCenterQuestionBatch,
    answers: AnswerPayload,
  ) => Promise<void>;
  acknowledge: (item: ActionCenterItem) => Promise<void>;
  dismiss: (item: ActionCenterItem) => Promise<void>;
  reportError: (value: string | null) => void;
};

const ActionCenterContext = createContext<ActionCenterContextValue | null>(
  null,
);

async function fetchActionCenter(
  after: string | null = null,
  first = PAGE_SIZE,
  signal?: AbortSignal,
): Promise<ActionCenterPageView> {
  const data = await controlPlaneRequest<{
    actionCenter: ActionCenterPageView;
  }>(
    `query ActionCenter($first: Int!, $after: String) {
      actionCenter(first: $first, after: $after) {
        items { ${ACTION_CENTER_ITEM_FIELDS} }
        nextCursor totalCount needsAttentionCount activeCount
      }
    }`,
    { first, after },
    { signal },
  );
  if (!data.actionCenter) {
    throw new Error("Action Center data is unavailable");
  }
  return data.actionCenter;
}

export function ActionCenterProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ActionCenterItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [needsAttentionCount, setNeedsAttentionCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedCount = useRef(0);

  useEffect(() => {
    loadedCount.current = items.length;
  }, [items.length]);

  const apply = useCallback((page: ActionCenterPageView, append = false) => {
    setItems((current) => {
      if (!append) return page.items;
      const existing = new Set(current.map(({ key }) => key));
      return [
        ...current,
        ...page.items.filter(({ key }) => !existing.has(key)),
      ];
    });
    setNextCursor(page.nextCursor);
    setTotalCount(page.totalCount);
    setNeedsAttentionCount(page.needsAttentionCount);
    setActiveCount(page.activeCount);
    setError(null);
  }, []);

  const refreshOwner = useRef<ReturnType<typeof createRefreshCoalescer> | null>(
    null,
  );
  const lifetime = useRef<AbortController | null>(null);
  const pageGeneration = useRef(0);
  const pageRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    await refreshOwner.current?.refresh();
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || pageRequest.current) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    const generation = pageGeneration.current;
    const signal = controller.signal;
    setLoadingMore(true);
    try {
      const page = await fetchActionCenter(nextCursor, PAGE_SIZE, signal);
      if (!signal?.aborted && generation === pageGeneration.current)
        apply(page, true);
    } catch (value) {
      if (!signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (pageRequest.current === controller) pageRequest.current = null;
      if (!signal.aborted && generation === pageGeneration.current)
        setLoadingMore(false);
    }
  }, [apply, loadingMore, nextCursor]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const updates = createRefreshCoalescer(async (signal) => {
      const generation = ++pageGeneration.current;
      pageRequest.current?.abort();
      pageRequest.current = null;
      setLoadingMore(false);
      try {
        const first = Math.max(PAGE_SIZE, loadedCount.current);
        const result = await readCursorWindow(
          (after, count) => fetchActionCenter(after, count, signal),
          first,
          200,
          (item: ActionCenterItem) => item.key,
        );
        if (!signal.aborted && generation === pageGeneration.current)
          apply(result);
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    refreshOwner.current = updates;
    const initial = window.setTimeout(() => void updates.refresh(), 0);
    const poll = window.setInterval(() => void updates.refresh(), 30_000);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: "subscription ActionCenterChanged { actionCenterChanged }" },
      {
        next: () => void updates.refresh(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const reconnect = onControlPlaneRecovery(
      (event) => {
        void (event?.initialConnection
          ? updates.refreshIfIdle()
          : updates.refresh());
      },
      { includeInitial: true },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
      unsubscribe();
      reconnect();
      updates.dispose();
      controller.abort();
      pageRequest.current?.abort();
      pageRequest.current = null;
      refreshOwner.current = null;
    };
  }, [apply]);

  const answerQuestion = useCallback(
    async (
      item: ActionCenterItem,
      batch: ActionCenterQuestionBatch,
      answers: AnswerPayload,
    ) => {
      try {
        if (item.resourceKind === "WORKFLOW") {
          await controlPlaneRequest(
            `mutation AnswerActionCenterWorkflowQuestion($batchId: ID!, $answers: JSON!) {
              answerWorkflowQuestion(batchId: $batchId, answers: $answers) { id status }
            }`,
            { batchId: batch.id, answers },
          );
        } else {
          await controlPlaneRequest(
            `mutation AnswerActionCenterRunQuestion($batchId: ID!, $answers: JSON!) {
              answerRunQuestion(batchId: $batchId, answers: $answers) { id status }
            }`,
            { batchId: batch.id, answers },
          );
        }
        await refresh();
      } catch (value) {
        const message = value instanceof Error ? value.message : String(value);
        setError(message);
        throw value;
      }
    },
    [refresh],
  );

  const acknowledge = useCallback(
    async (item: ActionCenterItem) => {
      if (!item.failureFingerprint) return;
      const previous = items;
      setItems((current) => current.filter(({ key }) => key !== item.key));
      try {
        await controlPlaneRequest(
          `mutation AcknowledgeActionCenterItem($input: AcknowledgeActionCenterItemInput!) {
            acknowledgeActionCenterItem(input: $input)
          }`,
          {
            input: {
              resourceKind: item.resourceKind,
              resourceId: item.resourceId,
              failureFingerprint: item.failureFingerprint,
            },
          },
        );
        await refresh();
      } catch (value) {
        setItems(previous);
        const message = value instanceof Error ? value.message : String(value);
        setError(message);
        throw value;
      }
    },
    [items, refresh],
  );

  const dismiss = useCallback(
    async (item: ActionCenterItem) => {
      if (!item.dismissalFingerprint) return;
      const previous = items;
      setItems((current) => current.filter(({ key }) => key !== item.key));
      try {
        await controlPlaneRequest(
          `mutation DismissActionCenterItem($input: DismissActionCenterItemInput!) {
            dismissActionCenterItem(input: $input)
          }`,
          {
            input: {
              resourceKind: item.resourceKind,
              resourceId: item.resourceId,
              dismissalFingerprint: item.dismissalFingerprint,
            },
          },
        );
        await refresh();
      } catch (value) {
        setItems(previous);
        const message = value instanceof Error ? value.message : String(value);
        setError(message);
        throw value;
      }
    },
    [items, refresh],
  );

  return (
    <ActionCenterContext.Provider
      value={{
        items,
        totalCount,
        needsAttentionCount,
        activeCount,
        loading,
        loadingMore,
        error,
        hasMore: Boolean(nextCursor),
        refresh,
        loadMore,
        answerQuestion,
        acknowledge,
        dismiss,
        reportError: setError,
      }}
    >
      {children}
    </ActionCenterContext.Provider>
  );
}

export function useActionCenter(): ActionCenterContextValue {
  const value = useContext(ActionCenterContext);
  if (!value) {
    throw new Error("useActionCenter must be used inside ActionCenterProvider");
  }
  return value;
}

export function useOptionalActionCenter(): ActionCenterContextValue | null {
  return useContext(ActionCenterContext);
}
