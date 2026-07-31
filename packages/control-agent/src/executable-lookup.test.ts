import { describe, expect, test } from "vitest";

import {
  extendedPath,
  findExecutable,
  prependPathDirectory,
  repairToolPath,
} from "./executable-lookup.js";

const launchdEnvironment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

describe("findExecutable", () => {
  test("finds a Homebrew install that the launchd service PATH omits", () => {
    expect(
      findExecutable("ccusage", {
        env: launchdEnvironment,
        home: "/Users/test",
        platform: "darwin",
        nodeDirectory: "/opt/homebrew/opt/node@24/bin",
        isExecutable: (path) => path === "/opt/homebrew/bin/ccusage",
      }),
    ).toBe("/opt/homebrew/bin/ccusage");
  });

  test("finds a global npm install beside the node running the agent", () => {
    expect(
      findExecutable("ccusage", {
        env: launchdEnvironment,
        home: "/Users/test",
        platform: "darwin",
        nodeDirectory: "/opt/homebrew/opt/node@24/bin",
        isExecutable: (path) =>
          path === "/opt/homebrew/opt/node@24/bin/ccusage",
      }),
    ).toBe("/opt/homebrew/opt/node@24/bin/ccusage");
  });

  test("prefers PATH over the fallback directories", () => {
    expect(
      findExecutable("ccusage", {
        env: { PATH: "/usr/bin:/Users/test/.local/bin" },
        home: "/Users/test",
        platform: "darwin",
        nodeDirectory: "/opt/homebrew/opt/node@24/bin",
        isExecutable: () => true,
      }),
    ).toBe("/usr/bin/ccusage");
  });

  test("honors an explicitly configured executable", () => {
    expect(
      findExecutable("ccusage", {
        overrideVariable: "CONTROL_AGENT_CCUSAGE_EXECUTABLE",
        env: {
          ...launchdEnvironment,
          CONTROL_AGENT_CCUSAGE_EXECUTABLE: "/custom/ccusage",
        },
        home: "/Users/test",
        platform: "darwin",
        nodeDirectory: "/opt/homebrew/opt/node@24/bin",
        isExecutable: (path) => path === "/custom/ccusage",
      }),
    ).toBe("/custom/ccusage");
  });

  test("returns nothing when the tool is not installed", () => {
    expect(
      findExecutable("ccusage", {
        env: launchdEnvironment,
        home: "/Users/test",
        platform: "darwin",
        nodeDirectory: "/opt/homebrew/opt/node@24/bin",
        isExecutable: () => false,
      }),
    ).toBeUndefined();
  });
});

describe("repairToolPath", () => {
  test("appends the tool directories the launchd PATH omits", () => {
    const env = { ...launchdEnvironment };
    repairToolPath({
      env,
      home: "/Users/test",
      platform: "darwin",
      nodeDirectory: "/opt/homebrew/opt/node@24/bin",
    });
    expect(env.PATH.split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/Users/test/.local/bin",
      "/Users/test/.bun/bin",
      "/Users/test/.npm-global/bin",
      "/Users/test/.opencode/bin",
      "/opt/homebrew/opt/node@24/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  test("does not duplicate directories that PATH already lists", () => {
    const path = extendedPath({
      env: { PATH: "/opt/homebrew/bin:/usr/bin" },
      home: "/Users/test",
      platform: "darwin",
      nodeDirectory: "/usr/bin",
    });
    expect(
      path.split(":").filter((entry) => entry === "/opt/homebrew/bin"),
    ).toHaveLength(1);
    expect(
      path.split(":").filter((entry) => entry === "/usr/bin"),
    ).toHaveLength(1);
  });
});

describe("prependPathDirectory", () => {
  test("moves a resolved tool directory to the front of PATH", () => {
    const env = { PATH: "/usr/bin:/opt/homebrew/bin" };
    prependPathDirectory("/opt/homebrew/bin", env);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  test("leaves PATH alone when the directory already leads", () => {
    const env = { PATH: "/opt/homebrew/bin:/usr/bin" };
    prependPathDirectory("/opt/homebrew/bin", env);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });
});
