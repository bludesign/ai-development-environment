"use client";

import { useSyncExternalStore } from "react";

/**
 * A preset is the whole triple, not just the model: `Opus / high` and
 * `Opus / max` are different choices a reader makes for different work, so
 * effort belongs in the identity rather than being re-picked every time.
 */
export type ModelPreset = { provider: string; model: string; effort: string };

const storageKey = "aide.model-presets.v1";
const legacyStorageKey = "aide.favorite-models.v1";
const changeEvent = "aide:model-presets";
const separator = "\u0000";
const recentLimit = 6;

export const modelPresetRailLimit = 4;

type PresetStore = { pinned: ModelPreset[]; recent: ModelPreset[] };

export function modelPresetKey({ provider, model, effort }: ModelPreset) {
  return `${provider}${separator}${model}${separator}${effort}`;
}

export function sameModelPreset(left: ModelPreset, right: ModelPreset) {
  return modelPresetKey(left) === modelPresetKey(right);
}

/**
 * Both keys go into one snapshot string so `useSyncExternalStore` can compare
 * it by value, and so a reader who never re-pins anything keeps seeing their
 * migrated favorites instead of an empty rail.
 */
function snapshot() {
  if (typeof window === "undefined") return separator;
  try {
    const current = window.localStorage.getItem(storageKey) ?? "";
    const legacy = window.localStorage.getItem(legacyStorageKey) ?? "";
    return `${current}${separator}${legacy}`;
  } catch {
    return separator;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(changeEvent, onChange);
  };
}

function readJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function readPresets(value: unknown): ModelPreset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { provider, model, effort } = entry as Record<string, unknown>;
    if (typeof provider !== "string" || typeof model !== "string") return [];
    return [
      {
        provider,
        model,
        effort: typeof effort === "string" ? effort : "auto",
      },
    ];
  });
}

/** Favorites predate presets and carried no effort, so they migrate to `auto`. */
function migrateFavorites(value: unknown): ModelPreset[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([provider, models]) =>
      Array.isArray(models)
        ? models
            .filter((model): model is string => typeof model === "string")
            .map((model) => ({ provider, model, effort: "auto" }))
        : [],
  );
}

function parseStore(raw: string): PresetStore {
  const [current = "", legacy = ""] = raw.split(separator);
  const parsed = readJson(current);
  if (parsed && typeof parsed === "object") {
    const { pinned, recent } = parsed as Record<string, unknown>;
    return { pinned: readPresets(pinned), recent: readPresets(recent) };
  }
  return { pinned: migrateFavorites(readJson(legacy)), recent: [] };
}

function save(next: PresetStore) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next));
    window.dispatchEvent(new Event(changeEvent));
  } catch {
    // A private browsing policy may make local storage unavailable.
  }
}

/**
 * Pinned presets are curated; recents are earned. Seeding the rail from what
 * was used last means it is useful after the first run rather than only for
 * readers who go looking for a pin control.
 */
export function useModelPresets() {
  const store = parseStore(
    useSyncExternalStore(subscribe, snapshot, () => separator),
  );
  const isPinned = (preset: ModelPreset) =>
    store.pinned.some((entry) => sameModelPreset(entry, preset));
  return {
    isPinned,
    pinned: store.pinned,
    rail: [
      ...store.pinned,
      ...store.recent.filter((entry) => !isPinned(entry)),
    ],
    togglePin: (preset: ModelPreset) =>
      save({
        pinned: isPinned(preset)
          ? store.pinned.filter((entry) => !sameModelPreset(entry, preset))
          : [...store.pinned, preset],
        recent: store.recent.filter((entry) => !sameModelPreset(entry, preset)),
      }),
    remember: (preset: ModelPreset) => {
      if (isPinned(preset)) return;
      save({
        pinned: store.pinned,
        recent: [
          preset,
          ...store.recent.filter((entry) => !sameModelPreset(entry, preset)),
        ].slice(0, recentLimit),
      });
    },
  };
}
