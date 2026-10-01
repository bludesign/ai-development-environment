import { describe, expect, test } from "vitest";

import {
  filterBranchRows,
  localBranchRows,
  reconcileBranchSelection,
} from "./branches-model";
import type { CodebaseRepository } from "./types";

const now = Date.parse("2026-10-01T00:00:00Z");
const repositories = [
  {
    id: "repo",
    name: "App",
    codebases: ["a", "b"].map((id) => ({
      id,
      folder: `/${id}`,
      availability: "AVAILABLE",
      defaultBranch: "main",
      activeJob: null,
      agent: {
        id,
        name: id,
        connectionStatus: id === "a" ? "ONLINE" : "OFFLINE",
        capabilities: ["codebase.branches.delete"],
      },
      localBranchInventory: {
        scannedAt: new Date(now).toISOString(),
        branches: [
          {
            name: "feature",
            headSha: "a".repeat(40),
            current: false,
            checkedOutPath: null,
            lastCommitMessage: "Work",
            lastCommitAt: new Date(now - 30 * 86_400_000).toISOString(),
          },
          {
            name: "main",
            headSha: "a".repeat(40),
            current: true,
            checkedOutPath: `/${id}`,
            lastCommitMessage: null,
            lastCommitAt: null,
          },
        ],
      },
    })),
  },
] as unknown as CodebaseRepository[];

describe("branch inventory filters and selection", () => {
  test("combines repository and agent filters and includes exact age boundaries", () => {
    const rows = localBranchRows(repositories);
    expect(rows).toHaveLength(4);
    expect(filterBranchRows(rows, "all", "repo", 30, now)).toHaveLength(2);
    expect(filterBranchRows(rows, "a", "repo", 30, now)).toHaveLength(1);
    expect(filterBranchRows(rows, "a", "repo", 31, now)).toHaveLength(0);
    expect(
      filterBranchRows(rows, "all", "all", null, now).at(-1)?.branch
        .lastCommitAt,
    ).toBeNull();
    expect(rows.find((row) => row.key === "b:feature")?.restriction).toBe(
      "offline",
    );
  });
  test("drops changed tips, protected branches, and unavailable selections without conflating agents", () => {
    const rows = localBranchRows(repositories);
    const selection = {
      "a:feature": "a".repeat(40),
      "b:feature": "a".repeat(40),
      "a:main": "a".repeat(40),
    };
    expect(reconcileBranchSelection(selection, rows)).toEqual({
      "a:feature": "a".repeat(40),
    });
    expect(
      reconcileBranchSelection(
        selection,
        rows.map((row) => ({
          ...row,
          branch: { ...row.branch, headSha: "b".repeat(40) },
        })),
      ),
    ).toEqual({});
  });
  test("keeps legacy local names visible with unknown ages and no cleanup capability", () => {
    const legacy = {
      ...repositories[0],
      codebases: [
        {
          ...repositories[0]!.codebases[0],
          localBranches: ["legacy"],
          remoteBranches: ["remote-only"],
          localBranchInventory: null,
        },
      ],
    } as CodebaseRepository;
    const rows = localBranchRows([legacy]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      branch: { name: "legacy", lastCommitAt: null },
      restriction: "metadataMissing",
    });
  });
});
