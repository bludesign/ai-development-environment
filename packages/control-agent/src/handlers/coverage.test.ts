import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { importCoverageReport } from "./coverage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function worktree(reportPath: string, contents: string) {
  const folder = await mkdtemp(join(tmpdir(), "aide-coverage-test-"));
  directories.push(folder);
  await mkdir(join(folder, "coverage"), { recursive: true });
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, reportPath), contents);
  return folder;
}

function payload(folder: string, overrides: Record<string, unknown> = {}) {
  return {
    buildId: "build-1",
    codebaseId: "codebase-1",
    worktreeId: "worktree-1",
    folder,
    reportPath: "coverage/lcov.info",
    format: "AUTO",
    // Changed-line coverage needs a base ref this fixture has no git repo for.
    baseBranch: null,
    ...overrides,
  };
}

const lcov = [
  "SF:src/covered.ts",
  "DA:1,2",
  "DA:2,0",
  "end_of_record",
  "",
].join("\n");

async function run(payloadValue: Record<string, unknown>) {
  const logs: string[] = [];
  const result = await importCoverageReport(
    payloadValue,
    5_000,
    new AbortController().signal,
    async (log) => {
      logs.push(log.message);
    },
  );
  return { logs, result: result as Record<string, unknown> };
}

describe("coverage import handler", () => {
  test("returns a READY report for a file inside the worktree", async () => {
    const folder = await worktree("coverage/lcov.info", lcov);
    const { logs, result } = await run(payload(folder));
    expect(result).toMatchObject({ exitCode: 0, cancelled: false });
    expect(result.report).toMatchObject({
      kind: "CODE_COVERAGE",
      status: "READY",
      summary: { coveredLines: 1, executableLines: 2, fileCount: 1 },
    });
    expect(result.sessionPatch).toEqual({
      build: { coverageSummary: expect.objectContaining({ fileCount: 1 }) },
    });
    expect(logs).toContain("Imported 1 files from coverage/lcov.info");
  });

  test("reads an Istanbul report when the format is pinned", async () => {
    const folder = await worktree(
      "coverage/coverage-final.json",
      JSON.stringify({
        "src/covered.ts": {
          path: "src/covered.ts",
          statementMap: { "0": { start: { line: 3 }, end: { line: 3 } } },
          s: { "0": 1 },
        },
      }),
    );
    const { result } = await run(
      payload(folder, {
        reportPath: "coverage/coverage-final.json",
        format: "ISTANBUL",
      }),
    );
    expect(result.report).toMatchObject({
      summary: { coveredLines: 1, executableLines: 1, lineCoverage: 1 },
    });
  });

  test("refuses a missing file and one that describes nothing", async () => {
    const folder = await worktree("coverage/lcov.info", "TN:\n");
    await expect(
      run(payload(folder, { reportPath: "coverage/absent.info" })),
    ).rejects.toThrow("does not exist");
    await expect(run(payload(folder))).rejects.toThrow("described no files");
  });

  test("refuses a path that escapes the worktree", async () => {
    const folder = await worktree("coverage/lcov.info", lcov);
    await expect(
      run(payload(folder, { reportPath: "../escape.info" })),
    ).rejects.toThrow("inside the worktree");
  });
});
