"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";

export type ActiveAgentOption = {
  id: string;
  name: string;
  hostname: string;
  connectionStatus: string;
};

type Preferences = {
  activeAgentId: string | null;
  pageAgents: Record<string, string>;
};
const emptyPreferences: Preferences = { activeAgentId: null, pageAgents: {} };

export function activeAgentStorageKey(userId: string) {
  return `ade.active-agent.${encodeURIComponent(userId)}`;
}

export function parseActiveAgentPreferences(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw ?? "null");
    return {
      activeAgentId:
        typeof value?.activeAgentId === "string" && value.activeAgentId
          ? value.activeAgentId
          : null,
      pageAgents: Object.fromEntries(
        Object.entries(value?.pageAgents ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
  } catch {
    return emptyPreferences;
  }
}

const serverSnapshot = { preferences: emptyPreferences, ready: false };

function createPreferenceStore(storageKey: string) {
  let snapshot: typeof serverSnapshot | undefined;
  const listeners = new Set<() => void>();
  const getSnapshot = () => {
    if (!snapshot) {
      let preferences = emptyPreferences;
      try {
        preferences = parseActiveAgentPreferences(
          window.localStorage.getItem(storageKey),
        );
      } catch {
        /* Storage may be disabled. */
      }
      snapshot = { preferences, ready: true };
    }
    return snapshot;
  };
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key !== storageKey && event.key !== null) return;
        snapshot = {
          preferences: parseActiveAgentPreferences(event.newValue),
          ready: true,
        };
        notify();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    update(transform: (previous: Preferences) => Preferences) {
      const preferences = transform(getSnapshot().preferences);
      snapshot = { preferences, ready: true };
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(preferences));
      } catch {
        /* Retain the in-memory choice. */
      }
      notify();
    },
  };
}

type ActiveAgentContextValue = {
  activeAgentId: string | null;
  activeAgent: ActiveAgentOption | null;
  agents: ActiveAgentOption[];
  ready: boolean;
  loading: boolean;
  error: string | null;
  selectAgent: (id: string | null) => void;
  refresh: () => void;
  pageAgents: Record<string, string>;
  setPageAgent: (page: string, id: string) => void;
};

const ActiveAgentContext = createContext<ActiveAgentContextValue | null>(null);
const inactiveContext: ActiveAgentContextValue = {
  activeAgentId: null,
  activeAgent: null,
  agents: [],
  ready: true,
  loading: false,
  error: null,
  selectAgent: () => undefined,
  refresh: () => undefined,
  pageAgents: {},
  setPageAgent: () => undefined,
};

export function ActiveAgentProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  // Remount on account changes so neither stored preferences nor in-flight reads cross users.
  return (
    <ScopedActiveAgentProvider key={userId} userId={userId}>
      {children}
    </ScopedActiveAgentProvider>
  );
}

function ScopedActiveAgentProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const [store] = useState(() =>
    createPreferenceStore(activeAgentStorageKey(userId)),
  );
  const { preferences, ready } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const [agents, setAgents] = useState<ActiveAgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef<RefreshCoalescer | null>(null);
  const update = store.update;
  const selectAgent = useCallback(
    (activeAgentId: string | null) =>
      update((previous) => ({ ...previous, activeAgentId })),
    [update],
  );
  const setPageAgent = useCallback(
    (page: string, id: string) =>
      update((previous) => ({
        ...previous,
        pageAgents: { ...previous.pageAgents, [page]: id },
      })),
    [update],
  );
  const refresh = useCallback(() => {
    void owner.current?.refresh();
  }, []);

  useEffect(() => {
    const updates = createRefreshCoalescer(async (signal) => {
      setLoading(true);
      try {
        const data = await controlPlaneRequest<{ agents: ActiveAgentOption[] }>(
          `query ActiveAgentOptions { agents { id name hostname connectionStatus } }`,
          undefined,
          { signal },
        );
        if (signal.aborted) return;
        const options = [...data.agents].sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            a.hostname.localeCompare(b.hostname),
        );
        setAgents(options);
        setError(null);
        const selected = store.getSnapshot().preferences.activeAgentId;
        if (selected && !options.some(({ id }) => id === selected))
          selectAgent(null);
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    owner.current = updates;
    const recover = () => {
      if (document.visibilityState !== "hidden") void updates.refresh();
    };
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      {
        query: "subscription ActiveAgentOptionsChanged { agentChanged { id } }",
      },
      {
        next: () => void updates.refresh(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const offRecovery = onControlPlaneRecovery(recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    void updates.refresh();
    return () => {
      owner.current = null;
      updates.dispose();
      unsubscribe();
      offRecovery();
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [selectAgent, store]);

  return (
    <ActiveAgentContext.Provider
      value={{
        ...preferences,
        activeAgent:
          agents.find(({ id }) => id === preferences.activeAgentId) ?? null,
        agents,
        ready,
        loading,
        error,
        selectAgent,
        refresh,
        setPageAgent,
      }}
    >
      {children}
    </ActiveAgentContext.Provider>
  );
}

export function useActiveAgent() {
  return useContext(ActiveAgentContext) ?? inactiveContext;
}

/** Independent baseline: global selections never overwrite this value. */
export function usePageAgentFilter(page: string, fallback: string) {
  const context = useContext(ActiveAgentContext);
  const [local, setLocal] = useState(fallback);
  const value = context ? (context.pageAgents[page] ?? fallback) : local;
  const setValue = (id: string) =>
    context ? context.setPageAgent(page, id) : setLocal(id);
  return [value, setValue] as const;
}
