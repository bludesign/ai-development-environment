"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import { createLiveRefresh } from "@/lib/live-refresh";
import { readCursorWindow } from "@/lib/read-cursor-window";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

import {
  ACTION_CENTER_ITEM_FIELDS,
  type ActionCenterItem,
  type ActionCenterPageView,
  type ActionCenterQuestionBatch,
} from "./types";

const PAGE_SIZE = 50;
const WINDOW_PAGE_LIMIT = 200;
/** Events arrive in bursts while agents work; one refresh per burst is enough. */
const EVENT_REFRESH_INTERVAL_MS = 5_000;
const RECONCILE_INTERVAL_MS = 30_000;

export type ActionCenterSurfaceName = "FULL" | "SIDEBAR";
const SURFACES: ActionCenterSurfaceName[] = ["FULL", "SIDEBAR"];

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
  refreshRequests: (forcePullRequests?: boolean) => Promise<void>;
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

type SurfaceState = {
  items: ActionCenterItem[];
  nextCursor: string | null;
  totalCount: number;
  needsAttentionCount: number;
  activeCount: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
};

type ActionCenterStore = {
  surfaces: Record<ActionCenterSurfaceName, ActionCenterContextValue>;
  /** Keeps a surface's list loaded while something displays it. */
  watch: (surface: ActionCenterSurfaceName) => () => void;
};

const ActionCenterContext = createContext<ActionCenterContextValue | null>(
  null,
);
const ActionCenterStoreContext = createContext<ActionCenterStore | null>(null);

const emptySurface = (): SurfaceState => ({
  items: [],
  nextCursor: null,
  totalCount: 0,
  needsAttentionCount: 0,
  activeCount: 0,
  loading: true,
  loadingMore: false,
  error: null,
});

const PAGE_FIELDS = `items { ${ACTION_CENTER_ITEM_FIELDS} }
        nextCursor totalCount needsAttentionCount activeCount warnings`;

/**
 * One request serves both surfaces. A surface nobody is displaying asks for a
 * single item, which still returns the totals the shell shows everywhere.
 */
const ACTION_CENTER_QUERY = `query ActionCenter($sidebarFirst: Int!, $fullFirst: Int!) {
      sidebar: actionCenter(first: $sidebarFirst, surface: SIDEBAR) {
        ${PAGE_FIELDS}
      }
      full: actionCenter(first: $fullFirst, surface: FULL) {
        ${PAGE_FIELDS}
      }
    }`;

async function fetchActionCenterPage(
  after: string,
  first: number,
  signal: AbortSignal,
  surface: ActionCenterSurfaceName,
): Promise<ActionCenterPageView> {
  const data = await controlPlaneRequest<{
    actionCenter: ActionCenterPageView;
  }>(
    `query ActionCenterPage($first: Int!, $after: String, $surface: ActionCenterSurface!) {
      actionCenter(first: $first, after: $after, surface: $surface) {
        ${PAGE_FIELDS}
      }
    }`,
    { first, after, surface },
    { signal },
  );
  if (!data.actionCenter) {
    throw new Error("Action Center data is unavailable");
  }
  return data.actionCenter;
}

const ACKNOWLEDGE_MUTATION = `mutation AcknowledgeActionCenterItem($input: AcknowledgeActionCenterItemInput!) {
            acknowledgeActionCenterItem(input: $input)
          }`;
const DISMISS_MUTATION = `mutation DismissActionCenterItem($input: DismissActionCenterItemInput!) {
            dismissActionCenterItem(input: $input)
          }`;

const errorMessage = (value: unknown) =>
  value instanceof Error ? value.message : String(value);

export function ActionCenterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    Record<ActionCenterSurfaceName, SurfaceState>
  >(() => ({ FULL: emptySurface(), SIDEBAR: emptySurface() }));
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const patch = useCallback(
    (
      surface: ActionCenterSurfaceName,
      change:
        | Partial<SurfaceState>
        | ((current: SurfaceState) => Partial<SurfaceState>),
    ) =>
      setState((current) => ({
        ...current,
        [surface]: {
          ...current[surface],
          ...(typeof change === "function" ? change(current[surface]) : change),
        },
      })),
    [],
  );

  const apply = useCallback(
    (
      surface: ActionCenterSurfaceName,
      page: ActionCenterPageView,
      mode: "replace" | "append" | "counts",
    ) =>
      patch(surface, (current) => {
        const existing = new Set(current.items.map(({ key }) => key));
        return {
          // A counts-only read leaves the last list in place for the next visit.
          ...(mode === "counts"
            ? {}
            : {
                items:
                  mode === "append"
                    ? [
                        ...current.items,
                        ...page.items.filter(({ key }) => !existing.has(key)),
                      ]
                    : page.items,
                nextCursor: page.nextCursor,
              }),
          totalCount: page.totalCount,
          needsAttentionCount: page.needsAttentionCount,
          activeCount: page.activeCount,
          error: page.warnings?.join(" · ") || null,
        };
      }),
    [patch],
  );

  const refreshOwner = useRef<ReturnType<typeof createRefreshCoalescer> | null>(
    null,
  );
  const watchers = useRef<Record<ActionCenterSurfaceName, number>>({
    FULL: 0,
    SIDEBAR: 0,
  });
  const pageGeneration = useRef(0);
  const pageRequests = useRef<
    Record<ActionCenterSurfaceName, AbortController | null>
  >({ FULL: null, SIDEBAR: null });
  const refresh = useCallback(async () => {
    await refreshOwner.current?.refresh();
  }, []);

  const watch = useCallback(
    (surface: ActionCenterSurfaceName) => {
      watchers.current[surface] += 1;
      if (watchers.current[surface] === 1) {
        // The list was not being kept current; show it as loading until it is.
        patch(surface, { loading: true });
        void refreshOwner.current?.refresh().catch(() => undefined);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        watchers.current[surface] -= 1;
      };
    },
    [patch],
  );

  useEffect(() => {
    const updates = createRefreshCoalescer(async (signal) => {
      const generation = ++pageGeneration.current;
      for (const surface of SURFACES) {
        pageRequests.current[surface]?.abort();
        pageRequests.current[surface] = null;
        if (stateRef.current[surface].loadingMore)
          patch(surface, { loadingMore: false });
      }
      const listing = {
        FULL: watchers.current.FULL > 0,
        SIDEBAR: watchers.current.SIDEBAR > 0,
      };
      const wanted = (surface: ActionCenterSurfaceName) =>
        listing[surface]
          ? Math.max(PAGE_SIZE, stateRef.current[surface].items.length)
          : 1;
      try {
        const data = await controlPlaneRequest<{
          sidebar: ActionCenterPageView;
          full: ActionCenterPageView;
        }>(
          ACTION_CENTER_QUERY,
          {
            sidebarFirst: Math.min(wanted("SIDEBAR"), WINDOW_PAGE_LIMIT),
            fullFirst: Math.min(wanted("FULL"), WINDOW_PAGE_LIMIT),
          },
          { signal },
        );
        if (!data.full || !data.sidebar) {
          throw new Error("Action Center data is unavailable");
        }
        const first = { FULL: data.full, SIDEBAR: data.sidebar };
        // Only a list longer than one page needs further requests.
        const pages = await Promise.all(
          SURFACES.map((surface) =>
            listing[surface]
              ? readCursorWindow(
                  (after, count) =>
                    after === null
                      ? Promise.resolve(first[surface])
                      : fetchActionCenterPage(after, count, signal, surface),
                  wanted(surface),
                  WINDOW_PAGE_LIMIT,
                  (item: ActionCenterItem) => item.key,
                )
              : first[surface],
          ),
        );
        if (signal.aborted || generation !== pageGeneration.current) return;
        SURFACES.forEach((surface, index) =>
          apply(
            surface,
            pages[index]!,
            listing[surface] ? "replace" : "counts",
          ),
        );
      } catch (value) {
        if (!signal.aborted)
          for (const surface of SURFACES)
            patch(surface, { error: errorMessage(value) });
      } finally {
        if (!signal.aborted)
          for (const surface of SURFACES)
            // A surface that started being displayed during this read is
            // still waiting for the read that lists it.
            if (listing[surface] || watchers.current[surface] === 0)
              patch(surface, { loading: false });
      }
    });
    refreshOwner.current = updates;
    const live = createLiveRefresh(() => updates.refresh(), {
      minIntervalMs: EVENT_REFRESH_INTERVAL_MS,
      pollMs: RECONCILE_INTERVAL_MS,
    });
    const initial = window.setTimeout(
      () => void updates.refresh().catch(() => undefined),
      0,
    );
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: "subscription ActionCenterChanged { actionCenterChanged }" },
      {
        next: () => live.invalidate(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const reconnect = onControlPlaneRecovery(
      (event) => {
        if (event?.initialConnection)
          void updates.refreshIfIdle().catch(() => undefined);
        else live.invalidate();
      },
      { includeInitial: true },
    );
    const requests = pageRequests.current;
    return () => {
      window.clearTimeout(initial);
      unsubscribe();
      reconnect();
      live.dispose();
      updates.dispose();
      for (const surface of SURFACES) {
        requests[surface]?.abort();
        requests[surface] = null;
      }
      refreshOwner.current = null;
    };
  }, [apply, patch]);

  const refreshRequests = useCallback(
    async (surface: ActionCenterSurfaceName, forcePullRequests = false) => {
      try {
        await controlPlaneRequest(
          "mutation RefreshActionCenter($forcePullRequests: Boolean!) { refreshActionCenter(forcePullRequests: $forcePullRequests) }",
          { forcePullRequests },
        );
        await refresh();
      } catch (value) {
        patch(surface, { error: errorMessage(value) });
      }
    },
    [patch, refresh],
  );

  const loadMore = useCallback(
    async (surface: ActionCenterSurfaceName) => {
      const { nextCursor, loadingMore } = stateRef.current[surface];
      if (!nextCursor || loadingMore || pageRequests.current[surface]) return;
      const controller = new AbortController();
      pageRequests.current[surface] = controller;
      const generation = pageGeneration.current;
      const signal = controller.signal;
      patch(surface, { loadingMore: true });
      try {
        const page = await fetchActionCenterPage(
          nextCursor,
          PAGE_SIZE,
          signal,
          surface,
        );
        if (!signal.aborted && generation === pageGeneration.current)
          apply(surface, page, "append");
      } catch (value) {
        if (!signal.aborted) patch(surface, { error: errorMessage(value) });
      } finally {
        if (pageRequests.current[surface] === controller)
          pageRequests.current[surface] = null;
        if (!signal.aborted && generation === pageGeneration.current)
          patch(surface, { loadingMore: false });
      }
    },
    [apply, patch],
  );

  const answerQuestion = useCallback(
    async (
      surface: ActionCenterSurfaceName,
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
        patch(surface, { error: errorMessage(value) });
        throw value;
      }
    },
    [patch, refresh],
  );

  /** Hide the item at once; put the list back if the server refuses. */
  const remove = useCallback(
    async (
      surface: ActionCenterSurfaceName,
      item: ActionCenterItem,
      fingerprint: "failureFingerprint" | "dismissalFingerprint",
      mutation: string,
    ) => {
      const value = item[fingerprint];
      if (!value) return;
      const previous = stateRef.current[surface].items;
      patch(surface, (current) => ({
        items: current.items.filter(({ key }) => key !== item.key),
      }));
      try {
        await controlPlaneRequest(mutation, {
          input: {
            resourceKind: item.resourceKind,
            resourceId: item.resourceId,
            [fingerprint]: value,
          },
        });
        await refresh();
      } catch (error) {
        patch(surface, { items: previous, error: errorMessage(error) });
        throw error;
      }
    },
    [patch, refresh],
  );

  const valueFor = useCallback(
    (
      surface: ActionCenterSurfaceName,
      { nextCursor, ...view }: SurfaceState,
    ): ActionCenterContextValue => ({
      ...view,
      hasMore: Boolean(nextCursor),
      refresh,
      refreshRequests: (forcePullRequests) =>
        refreshRequests(surface, forcePullRequests),
      loadMore: () => loadMore(surface),
      answerQuestion: (item, batch, answers) =>
        answerQuestion(surface, item, batch, answers),
      acknowledge: (item) =>
        remove(surface, item, "failureFingerprint", ACKNOWLEDGE_MUTATION),
      dismiss: (item) =>
        remove(surface, item, "dismissalFingerprint", DISMISS_MUTATION),
      reportError: (value) => patch(surface, { error: value }),
    }),
    [answerQuestion, loadMore, patch, refresh, refreshRequests, remove],
  );
  const full = useMemo(() => valueFor("FULL", state.FULL), [state, valueFor]);
  const sidebar = useMemo(
    () => valueFor("SIDEBAR", state.SIDEBAR),
    [state, valueFor],
  );
  const store = useMemo(
    () => ({ surfaces: { FULL: full, SIDEBAR: sidebar }, watch }),
    [full, sidebar, watch],
  );

  return (
    <ActionCenterStoreContext.Provider value={store}>
      <ActionCenterContext.Provider value={full}>
        {children}
      </ActionCenterContext.Provider>
    </ActionCenterStoreContext.Provider>
  );
}

/**
 * Displays one surface of the shell's Action Center, and keeps its list loaded
 * while mounted. Outside the shell it brings its own provider.
 */
export function ActionCenterSurface({
  surface,
  children,
}: {
  surface: ActionCenterSurfaceName;
  children: ReactNode;
}) {
  const store = useContext(ActionCenterStoreContext);
  if (!store)
    return (
      <ActionCenterProvider>
        <ActionCenterSurface surface={surface}>{children}</ActionCenterSurface>
      </ActionCenterProvider>
    );
  return (
    <WatchedSurface store={store} surface={surface}>
      {children}
    </WatchedSurface>
  );
}

function WatchedSurface({
  store,
  surface,
  children,
}: {
  store: ActionCenterStore;
  surface: ActionCenterSurfaceName;
  children: ReactNode;
}) {
  const { watch } = store;
  useEffect(() => watch(surface), [surface, watch]);
  return (
    <ActionCenterContext.Provider value={store.surfaces[surface]}>
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
