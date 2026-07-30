import { describe, expect, test } from "vitest";

import { findExecutable } from "./executable-lookup.js";

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
