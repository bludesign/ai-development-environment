import { describe, expect, test } from "vitest";

import {
  defaultBuildsDirectory,
  effectiveBuildsDirectory,
} from "./build-directory";

describe("build directory defaults", () => {
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
