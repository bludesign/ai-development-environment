import { describe, expect, test } from "vitest";

import { samplePayloadForCapability } from "./capability-payloads";

describe("samplePayloadForCapability", () => {
  test.each([
    ["cloudflared.runTunnel", { tunnelName: "" }],
    ["ccusage.report", {}],
    ["codebase.browse", { path: null }],
    ["codebase.inspect", { folder: "" }],
    ["codebase.refresh", { codebaseId: "", folder: "", expectedOrigin: "" }],
    [
      "codebase.fetch",
      {
        codebaseId: "",
        folder: "",
        expectedOrigin: "",
        baseBranch: "",
        keepBaseBranchUpToDate: false,
      },
    ],
    [
      "codebase.git.inspect",
      {
        action: "STATE",
        codebaseId: "",
        folder: "",
        expectedOrigin: "",
      },
    ],
    [
      "codebase.git.operation",
      {
        codebaseId: "",
        folder: "",
        expectedOrigin: "",
        defaultBranch: null,
        operation: "SWITCH_BRANCH",
        branch: "",
        stashChanges: false,
      },
    ],
    [
      "worktree.inspect",
      {
        codebaseId: "",
        folder: "",
        gitDirectory: "",
        expectedOrigin: "",
        baseBranch: null,
      },
    ],
    [
      "worktree.operation",
      {
        codebaseId: "",
        folder: "",
        gitDirectory: "",
        expectedOrigin: "",
        baseBranch: null,
        operation: "SYNC",
      },
    ],
    [
      "worktree.watch",
      {
        codebaseId: "",
        folder: "",
        gitDirectory: "",
        expectedOrigin: "",
        baseBranch: null,
        action: "START",
        watchId: "",
      },
    ],
    [
      "worktree.branch",
      {
        codebaseId: "",
        rootFolder: "",
        folder: null,
        gitDirectory: null,
        expectedOrigin: "",
        baseBranch: "",
        action: "CREATE",
        mode: "NEW",
        candidates: [""],
        stashOnFailure: false,
      },
    ],
    [
      "worktree.move.push",
      {
        moveId: "",
        codebaseId: "",
        folder: "",
        gitDirectory: "",
        expectedOrigin: "",
        branch: "",
        expectedHeadSha: "",
      },
    ],
    [
      "worktree.move.checkout",
      {
        moveId: "",
        codebaseId: "",
        rootFolder: "",
        folder: null,
        gitDirectory: null,
        expectedOrigin: "",
        branch: "",
        expectedHeadSha: "",
        baseBranch: "",
        mode: "NEW",
        stashOnFailure: false,
      },
    ],
    [
      "worktree.delete",
      {
        moveId: null,
        codebaseId: "",
        rootFolder: "",
        folder: "",
        gitDirectory: "",
        expectedOrigin: "",
        branch: null,
        defaultBranch: null,
        deleteRemoteBranch: false,
        requireClean: false,
        expectedHeadSha: null,
      },
    ],
  ])("returns the required shape for %s", (capability, expected) => {
    expect(samplePayloadForCapability(capability)).toEqual(expected);
  });

  test("falls back to an empty object for a future capability", () => {
    expect(samplePayloadForCapability("future.capability")).toEqual({});
  });
});
