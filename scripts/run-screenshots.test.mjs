// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { screenshotEnvironment } from "./run-screenshots.mjs";

const temporaryDirectories = [];

async function screenshotBuild(port) {
  const buildRoot = await mkdtemp(join(tmpdir(), "aide-screenshots-"));
  temporaryDirectories.push(buildRoot);
  const buildDirectory = join(buildRoot, ".next-mock");
  await mkdir(buildDirectory);
  await writeFile(
    join(buildDirectory, "routes-manifest.json"),
    JSON.stringify({
      rewrites: {
        beforeFiles: [],
        afterFiles: [
          {
            source: "/graphql",
            destination: `http://127.0.0.1:${port}/graphql`,
          },
        ],
        fallback: [],
      },
    }),
  );
  return buildRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("screenshot ports", () => {
  test("reuses the build-time WebSocket port when setup is skipped", async () => {
    const buildRoot = await screenshotBuild("43123");

    const environment = await screenshotEnvironment({
      skipSetup: true,
      environmentVariables: {},
      buildRoot,
      allocatePort: async () => "43124",
    });

    expect(environment.SCREENSHOT_PORT).toBe("43124");
    expect(environment.AGENT_WS_PORT).toBe("43123");
  });

  test("rejects a runtime WebSocket port that differs from the build", async () => {
    const buildRoot = await screenshotBuild("43123");

    await expect(
      screenshotEnvironment({
        skipSetup: true,
        environmentVariables: { AGENT_WS_PORT: "43125" },
        buildRoot,
        allocatePort: async () => "43124",
      }),
    ).rejects.toThrow(
      "AGENT_WS_PORT 43125 does not match the screenshot build port 43123",
    );
  });
});
