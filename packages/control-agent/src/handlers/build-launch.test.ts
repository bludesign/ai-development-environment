import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

const launch = vi.hoisted(() => ({ exitCode: 0, openExitCode: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      if (["xcrun", "/usr/bin/open", "/usr/bin/codesign"].includes(command)) {
        const exitCode =
          command === "/usr/bin/open"
            ? launch.openExitCode
            : command === "xcrun" && args.includes("launch")
              ? launch.exitCode
              : 0;
        return actual.spawn(
          process.execPath,
          ["-e", `process.exit(${exitCode})`],
          options,
        );
      }
      return actual.spawn(command, args, options);
    },
  };
});

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { deployIosBuild } from "./builds.js";
import {
  git,
  registerWorktreeFixtures,
  repository,
} from "./worktree-fixtures.js";

registerWorktreeFixtures();
beforeEach(() => {
  launch.exitCode = 0;
  launch.openExitCode = 0;
});

describe("device launch reports", () => {
  test.each([false, true])(
    "reports successful launches and retains a repair timestamp when reporting fails (%s)",
    async (reportFails) => {
      // A headless agent may launch an app without opening the simulator UI.
      if (!reportFails) launch.openExitCode = 1;
      const folder = await repository();
      const artifactDirectory = join(folder, "artifacts");
      await mkdir(join(artifactDirectory, "App.app"), { recursive: true });
      const report = vi.fn(async () => {
        if (reportFails) throw new Error("Server unavailable");
      });
      const result = (await deployIosBuild(
        {
          codebaseId: "codebase-1",
          worktreeId: "worktree-1",
          folder,
          gitDirectory: await realpath(join(folder, ".git")),
          expectedOrigin: normalizeGitOrigin(
            (await git(folder, "remote", "get-url", "origin")).stdout.trim(),
          ).canonicalOrigin,
          buildId: "build-1",
          artifactDirectory,
          artifactRelativePath: "App.app",
          bundleIdentifier: "com.example.app",
          deployments: [
            {
              id: "deployment-1",
              destination: {
                type: "SIMULATOR",
                id: "SIM-1",
                name: "iPhone",
                platform: "iOS Simulator",
                state: "Booted",
                osVersion: "26.0",
              },
            },
          ],
        },
        20_000,
        new AbortController().signal,
        async () => undefined,
        {
          agentId: "agent-1",
          reportWorktreeActivity: async () => undefined,
          reportBuildDeploymentLaunched: report,
        },
      )) as unknown as {
        exitCode: number;
        deployments: Array<{ id: string; status: string; launchedAt: string }>;
      };
      expect(result.exitCode).toBe(0);
      expect(result.deployments[0]).toMatchObject({
        id: "deployment-1",
        status: "SUCCEEDED",
      });
      expect(
        Number.isFinite(Date.parse(result.deployments[0]!.launchedAt)),
      ).toBe(true);
      expect(report).toHaveBeenCalledWith(
        "deployment-1",
        result.deployments[0]!.launchedAt,
      );
    },
  );

  test("never reports a failed launch as a successful run", async () => {
    launch.exitCode = 1;
    const folder = await repository();
    const artifactDirectory = join(folder, "artifacts");
    await mkdir(join(artifactDirectory, "App.app"), { recursive: true });
    const report = vi.fn();
    const result = (await deployIosBuild(
      {
        codebaseId: "codebase-1",
        worktreeId: "worktree-1",
        folder,
        gitDirectory: await realpath(join(folder, ".git")),
        expectedOrigin: normalizeGitOrigin(
          (await git(folder, "remote", "get-url", "origin")).stdout.trim(),
        ).canonicalOrigin,
        buildId: "build-1",
        artifactDirectory,
        artifactRelativePath: "App.app",
        bundleIdentifier: "com.example.app",
        deployments: [
          {
            id: "deployment-1",
            destination: {
              type: "SIMULATOR",
              id: "SIM-1",
              name: "iPhone",
              platform: "iOS Simulator",
              state: "Booted",
              osVersion: "26.0",
            },
          },
        ],
      },
      20_000,
      new AbortController().signal,
      async () => undefined,
      {
        agentId: "agent-1",
        reportWorktreeActivity: async () => undefined,
        reportBuildDeploymentLaunched: report,
      },
    )) as unknown as {
      exitCode: number;
      deployments: Array<{ status: string; launchedAt: string | null }>;
    };
    expect(result.exitCode).toBe(1);
    expect(result.deployments[0]).toMatchObject({
      status: "FAILED",
      launchedAt: null,
    });
    expect(report).not.toHaveBeenCalled();
  });
});
