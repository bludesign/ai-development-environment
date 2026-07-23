"use client";

import { useTranslations } from "next-intl";

import { formatEnumLabel } from "@/lib/enum-label";

/**
 * Run statuses, phases, checkpoint kinds, follow-up modes, and tool-call
 * statuses are closed sets this project writes itself (see
 * `src/services/runs/runs.service.ts` and the control agent's run manager), so
 * each value has a `runs.*` message key and renders localized.
 *
 * Event types are the one open set: the provider adapters forward the tool's
 * own stream type verbatim — Codex JSON-RPC methods and OpenCode SDK events
 * become `SESSION_UPDATE`, `MESSAGE_PART_UPDATED`, and so on — so the ones we
 * emit ourselves are translated and anything else falls back to a readable
 * rendering of the provider identifier.
 */
export function useRunLabels() {
  const t = useTranslations("runs");
  const lookup = (group: string, value: string) => {
    const key = `${group}.${value}`;
    return t.has(key) ? t(key) : null;
  };
  return {
    status: (value: string) =>
      lookup("statuses", value) ?? formatEnumLabel(value),
    phase: (value: string) => lookup("phases", value) ?? formatEnumLabel(value),
    checkpointKind: (value: string) =>
      lookup("checkpointKinds", value) ?? formatEnumLabel(value),
    followUpMode: (value: string) =>
      lookup("followUpModes", value) ?? formatEnumLabel(value),
    toolCallStatus: (value: string) =>
      lookup("toolCallStatuses", value) ?? formatEnumLabel(value),
    eventType: (value: string) =>
      lookup("eventTypes", value) ?? formatEnumLabel(value),
  };
}
