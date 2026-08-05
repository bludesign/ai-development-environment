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
  onControlPlaneConnected,
} from "@/lib/control-plane-client";

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
  reportError: (value: string | null) => void;
};

const ActionCenterContext = createContext<ActionCenterContextValue | null>(
  null,
);

async function fetchActionCenter(
  after: string | null = null,
  first = PAGE_SIZE,
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

  const refresh = useCallback(async () => {
    try {
      const first = Math.max(PAGE_SIZE, Math.min(loadedCount.current, 200));
      apply(await fetchActionCenter(null, first));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      apply(await fetchActionCenter(nextCursor), true);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingMore(false);
    }
  }, [apply, loadingMore, nextCursor]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const poll = window.setInterval(() => void refresh(), 30_000);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      actionCenterChanged: boolean;
    }>(
      { query: "subscription ActionCenterChanged { actionCenterChanged }" },
      {
        next: () => void refresh(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const reconnect = onControlPlaneConnected(() => void refresh());
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
      unsubscribe();
      reconnect();
    };
  }, [refresh]);

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
