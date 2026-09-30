"use client";
import { useSyncExternalStore } from "react";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";
import {
  SERVER_URL_SETTINGS_FIELDS,
  type ServerUrlSettings,
} from "@/lib/server-urls";

type Snapshot = { settings: ServerUrlSettings | null; error: string | null };
const initial: Snapshot = { settings: null, error: null };
let snapshot = initial;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const refreshOwner = createRefreshCoalescer(async () => {
  try {
    const data = await controlPlaneRequest<{
      serverUrlSettings: ServerUrlSettings;
    }>(
      `query SharedServerUrlSettings($origin: String) { serverUrlSettings(requestOrigin: $origin) { ${SERVER_URL_SETTINGS_FIELDS} } }`,
      { origin: window.location.origin },
    );
    snapshot = { settings: data.serverUrlSettings, error: null };
  } catch (error) {
    snapshot = {
      ...snapshot,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    emit();
  }
});
export function refreshServerUrlSettings(): Promise<void> {
  return refreshOwner.refresh();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!unsubscribe) {
    unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: "subscription { serverUrlSettingsChanged { updatedAt } }" },
      {
        next: () => {
          void refreshServerUrlSettings();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    void refreshOwner.refreshIfIdle();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = null;
    }
  };
}
export function useServerUrlSettings() {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => initial,
  );
  return {
    ...value,
    loading: !value.settings && !value.error,
    refresh: refreshServerUrlSettings,
  };
}
