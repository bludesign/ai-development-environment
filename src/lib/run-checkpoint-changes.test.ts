import { describe, expect, test } from "vitest";

import {
  latestFinalCheckpoint,
  normalizeCheckpointChanges,
} from "./run-checkpoint-changes";

const WORKTREE_PATCH = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-before
+after
`;
const INDEX_PATCH = WORKTREE_PATCH.replace("+after", "+staged");
const legacy = (diffPatch: string) => ({
  kind: "FINAL",
  diffPatch,
  diffSummary: "Staged:\nHEAD summary\n\nWorking tree:\nHEAD summary",
});

describe("checkpoint changes", () => {
  test("shows only net worktree changes from a legacy staged FINAL patch", () => {
    const result = normalizeCheckpointChanges(
      legacy(
        `Worktree changes that will be undone:\n\n${WORKTREE_PATCH}\nIndex changes that will be undone:\n\n${INDEX_PATCH}`,
      ),
    );

    expect(result).toEqual({
      diffPatch: WORKTREE_PATCH.trim(),
      diffSummary: null,
    });
    expect(result.diffPatch?.match(/^diff --git /gm)).toHaveLength(1);
    expect(result.diffPatch).not.toContain("+staged");
  });

  test("keeps the entire worktree section when no index section exists", () => {
    expect(
      normalizeCheckpointChanges(
        legacy(`Worktree changes that will be undone:\n\n${WORKTREE_PATCH}`),
      ),
    ).toEqual({ diffPatch: WORKTREE_PATCH.trim(), diffSummary: null });
  });

  test("treats legacy index-only changes as no content changes", () => {
    expect(
      normalizeCheckpointChanges(
        legacy(`Index changes that will be undone:\n\n${INDEX_PATCH}`),
      ),
    ).toEqual({ diffPatch: null, diffSummary: null });
  });

  test("preserves modern changes and non-FINAL checkpoints", () => {
    const modern = {
      kind: "FINAL",
      diffPatch: WORKTREE_PATCH,
      diffSummary: "1 file changed",
    };
    expect(normalizeCheckpointChanges(modern)).toEqual({
      diffPatch: WORKTREE_PATCH,
      diffSummary: "1 file changed",
    });
    const question = {
      ...legacy(`Worktree changes that will be undone:\n\n${WORKTREE_PATCH}`),
      kind: "QUESTION",
    };
    expect(normalizeCheckpointChanges(question)).toEqual({
      diffPatch: question.diffPatch,
      diffSummary: question.diffSummary,
    });
  });

  test("preserves empty authoritative checkpoints", () => {
    expect(
      normalizeCheckpointChanges({
        kind: "FINAL",
        diffPatch: null,
        diffSummary: null,
      }),
    ).toEqual({ diffPatch: null, diffSummary: null });
  });

  test("clears a legacy HEAD summary when FINAL has no net patch", () => {
    expect(
      normalizeCheckpointChanges({
        ...legacy(""),
        diffPatch: null,
      }),
    ).toEqual({ diffPatch: null, diffSummary: null });
    expect(
      normalizeCheckpointChanges({
        kind: "FINAL",
        diffPatch: null,
        diffSummary: "1 file changed",
      }),
    ).toEqual({ diffPatch: null, diffSummary: "1 file changed" });
  });

  test("selects the latest FINAL even when its patch is empty", () => {
    const emptyFinal = { id: "final-2", kind: "FINAL", diffPatch: null };
    expect(
      latestFinalCheckpoint([
        { id: "start", kind: "START", diffPatch: WORKTREE_PATCH },
        { id: "final-1", kind: "FINAL", diffPatch: WORKTREE_PATCH },
        emptyFinal,
        { id: "question", kind: "QUESTION", diffPatch: WORKTREE_PATCH },
      ]),
    ).toBe(emptyFinal);
    expect(latestFinalCheckpoint([{ kind: "START" }])).toBeNull();
    expect(latestFinalCheckpoint([])).toBeNull();
  });
});
