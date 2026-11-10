export type BulkMergeReview = {
  itemId: string;
  headSha: string;
  sourceBranch: string;
  sourceOrigin: string;
  targetBranch: string;
  instanceUrl?: string;
};

export function isUnknownMergeOutcome(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "mergeOutcomeUnknown" in error &&
    error.mergeOutcomeUnknown,
  );
}

export function unknownMergeOutcome(error: unknown) {
  return Object.assign(
    error instanceof Error ? error : new Error(String(error)),
    { mergeOutcomeUnknown: true },
  );
}
