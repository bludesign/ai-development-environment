"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";

import type { DiffViewLabels } from "./diff-view";
import type { ImageDiffLabels } from "./image-diff";

/**
 * The standard label set for `DiffView`, read from the shared `diffView`
 * namespace.
 *
 * The renderer takes labels as props rather than reading translations itself so
 * it stays pure and testable; this hook is the default wiring so callers do not
 * each assemble the same seven strings.
 */
export function useDiffViewLabels(): DiffViewLabels {
  const t = useTranslations("diffView");
  return useMemo(
    () => ({
      truncated: t("truncated"),
      binary: t("binary"),
      empty: t("empty"),
      largeDiff: (count: number) => t("largeDiff", { count }),
      renderAnyway: t("renderAnyway"),
      addComment: t("addComment"),
      noNewline: t("noNewline"),
    }),
    [t],
  );
}

/** The standard label set for `ImageDiff`, from the same namespace. */
export function useImageDiffLabels(): ImageDiffLabels {
  const t = useTranslations("diffView");
  return useMemo(
    () => ({
      sideBySide: t("sideBySide"),
      overlap: t("overlap"),
      difference: t("difference"),
      transparency: t("transparency"),
      sensitivity: t("sensitivity"),
      differenceSummary: (percent: string) =>
        t("differenceSummary", { percent }),
      comparing: t("comparingPixels"),
      needsBothSides: t("differenceNeedsBothSides"),
      failed: t("differenceFailed"),
      identical: t("imagesIdentical"),
      before: t("before"),
      after: t("after"),
      missing: t("missingImage"),
    }),
    [t],
  );
}
