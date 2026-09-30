"use client";
import { useEffect, useSyncExternalStore } from "react";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import {
  SERVER_URL_SETTINGS_FIELDS,
  type ServerUrlSettings,
} from "@/lib/server-urls";

type Snapshot = { settings: ServerUrlSettings | null; error: string | null };
const initial: Snapshot = { settings: null, error: null };
let snapshot = initial;
let pending: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export function refreshServerUrlSettings(): Promise<void> {
  pending ??= controlPlaneRequest<{ serverUrlSettings: ServerUrlSettings }>(
    `query SharedServerUrlSettings($origin: String) { serverUrlSettings(requestOrigin: $origin) { ${SERVER_URL_SETTINGS_FIELDS} } }`,
    { origin: window.location.origin },
  )
    .then((data) => {
      snapshot = { settings: data.serverUrlSettings, error: null };
    })
    .catch((error) => {
      snapshot = {
        ...snapshot,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      pending = null;
      emit();
    });
  return pending;
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
    void refreshServerUrlSettings();
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
  useEffect(() => {
    if (!snapshot.settings) void refreshServerUrlSettings();
  }, []);
  return {
    ...value,
    loading: !value.settings && !value.error,
    refresh: refreshServerUrlSettings,
  };
}
