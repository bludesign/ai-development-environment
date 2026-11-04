import { describe, expect, test } from "vitest";

import {
  defaultBuildsDirectory,
  effectiveBuildsDirectory,
  managedDerivedDataRoot,
  worktreeDerivedDataDirectory,
} from "./build-directory";

describe("build directory defaults", () => {
  test("keeps incremental caches stable and separate for each worktree", () => {
    expect(worktreeDerivedDataDirectory("/Builds", "worktree-a")).toBe(
      "/Builds/.worktree-derived-data/worktree-a",
    );
    expect(worktreeDerivedDataDirectory("/Builds", "worktree-b")).toBe(
      "/Builds/.worktree-derived-data/worktree-b",
    );
    expect(managedDerivedDataRoot("C:\\Builds")).toBe(
      "C:\\Builds\\.worktree-derived-data",
    );
    expect(() => worktreeDerivedDataDirectory("/Builds", "../escape")).toThrow(
      "Worktree identifier",
    );
  });
  test("places builds beneath the configured base repository directory", () => {
    expect(defaultBuildsDirectory("/Users/test/Repositories")).toBe(
      "/Users/test/Repositories/Builds",
    );
    expect(defaultBuildsDirectory("C:\\Repositories")).toBe(
      "C:\\Repositories\\Builds",
    );
  });

  test("uses a custom directory before the base repository default", () => {
    expect(
      effectiveBuildsDirectory({
        baseRepoDirectory: "/Users/test/Repositories",
        buildsDirectory: "/Volumes/Builds",
      }),
    ).toBe("/Volumes/Builds");
    expect(
      effectiveBuildsDirectory({
        baseRepoDirectory: null,
        buildsDirectory: null,
      }),
    ).toBeNull();
  });
});
