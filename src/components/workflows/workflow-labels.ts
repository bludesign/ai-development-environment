"use client";

import { useTranslations } from "next-intl";

import { formatKindLabel } from "@/lib/enum-label";

/**
 * Workflow badges render SCREAMING_SNAKE_CASE identifiers straight out of the
 * database, which shouts next to every other badge in the app. Statuses, run
 * event types, validation codes, and overlap policies are closed sets this
 * project defines itself, so each has a `workflows.*` message key and renders
 * localized.
 *
 * Step and trigger kinds are the open-ended set — the catalog in
 * `src/lib/workflows/definition.ts` grows with every integration, and its
 * labels are already served in English — so they fall back to a title-cased
 * rendering of the identifier that keeps brand casing (`GitHub Load PR`).
 */
export function useWorkflowLabels() {
  const t = useTranslations("workflows");
  const lookup = (group: string, value: string) => {
    const key = `${group}.${value}`;
    return t.has(key) ? t(key) : null;
  };
  return {
    status: (value: string) =>
      lookup("statuses", value) ?? formatKindLabel(value),
    eventType: (value: string) =>
      lookup("eventTypes", value) ?? formatKindLabel(value),
    diagnosticCode: (value: string) =>
      lookup("diagnosticCodes", value) ?? formatKindLabel(value),
    overlapPolicy: (value: string) =>
      lookup("overlapPolicies", value) ?? formatKindLabel(value),
    kind: (value: string) => formatKindLabel(value),
  };
}
