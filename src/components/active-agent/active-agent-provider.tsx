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
import { createLiveRefresh } from "@/lib/live-refresh";
import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";

export type ActiveAgentOption = {
  id: string;
  name: string;
  hostname: string;
  connectionStatus: string;
  capabilities?: string[];
};

const AGENT_OPTION_FIELDS = "id name hostname connectionStatus capabilities";
const RECONCILE_INTERVAL_MS = 60_000;

function sortAgents(options: ActiveAgentOption[]): ActiveAgentOption[] {
  return [...options].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.hostname.localeCompare(b.hostname),
  );
}

function sameOption(a: ActiveAgentOption, b: ActiveAgentOption): boolean {
  return (
    a.name === b.name &&
    a.hostname === b.hostname &&
    a.connectionStatus === b.connectionStatus &&
    (a.capabilities ?? []).join("\u0000") ===
      (b.capabilities ?? []).join("\u0000")
  );
}

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
    const known = new Set<string>();
    // A heartbeat that lands during a read is newer than that read's snapshot.
    let duringRead: Map<string, ActiveAgentOption> | null = null;
    const updates = createRefreshCoalescer(async (signal) => {
      setLoading(true);
      const arrived = new Map<string, ActiveAgentOption>();
      duringRead = arrived;
      try {
        const data = await controlPlaneRequest<{ agents: ActiveAgentOption[] }>(
          `query ActiveAgentOptions { agents { ${AGENT_OPTION_FIELDS} } }`,
          undefined,
          { signal },
        );
        if (signal.aborted) return;
        const options = sortAgents(
          data.agents.map((agent) => arrived.get(agent.id) ?? agent),
        );
        known.clear();
        for (const { id } of options) known.add(id);
        setAgents(options);
        setError(null);
        const selected = store.getSnapshot().preferences.activeAgentId;
        if (selected && !known.has(selected)) selectAgent(null);
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (duringRead === arrived) duringRead = null;
        if (!signal.aborted) setLoading(false);
      }
    });
    owner.current = updates;
    // An expired heartbeat or a deleted agent emits no event, so reconcile on a
    // slow cadence while someone is looking.
    const live = createLiveRefresh(() => updates.refresh(), {
      pollMs: RECONCILE_INTERVAL_MS,
    });
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      agentChanged: ActiveAgentOption;
    }>(
      {
        query: `subscription ActiveAgentOptionsChanged { agentChanged { ${AGENT_OPTION_FIELDS} } }`,
      },
      {
        next: (result) => {
          const changed = result.data?.agentChanged;
          if (!changed) return;
          duringRead?.set(changed.id, changed);
          if (!known.has(changed.id)) {
            // Not listed yet: a read in flight will include it; otherwise ask.
            if (!duringRead) live.invalidate();
            return;
          }
          // Every agent heartbeats every few seconds. Apply the payload rather
          // than reading the whole catalog again on each one.
          setAgents((current) => {
            const existing = current.find(({ id }) => id === changed.id);
            if (!existing || sameOption(existing, changed)) return current;
            return sortAgents(
              current.map((agent) =>
                agent.id === changed.id ? { ...agent, ...changed } : agent,
              ),
            );
          });
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const offRecovery = onControlPlaneRecovery(() => live.invalidate());
    void updates.refresh();
    return () => {
      owner.current = null;
      live.dispose();
      updates.dispose();
      unsubscribe();
      offRecovery();
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
