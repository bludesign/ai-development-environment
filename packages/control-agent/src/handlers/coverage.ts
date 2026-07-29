import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  buildCoverageReportPayload,
  parseCoverageImportPayload,
  parseCoverageReport,
} from "@ai-development-environment/agent-contract/coverage";

import { snapshotCoverageChanges } from "./builds.js";
import type { AgentJobHandler } from "./index.js";

/**
 * A coverage file is text a test runner wrote; 64 MiB is far past any real one
 * and still small enough to parse without starving the agent.
 */
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

/**
 * Reads a coverage file out of a worktree and returns it as a `CODE_COVERAGE`
 * report, so a workflow that runs its own test command can feed the same
 * coverage pages an Xcode build feeds.
 *
 * Changed-line coverage needs git, and a worktree without a base branch — or
 * one whose base ref was never fetched — still has useful whole-file numbers,
 * so a failed diff is logged and the report continues without the overlay.
 */
export const importCoverageReport: AgentJobHandler = async (
  payloadValue,
  timeoutMs,
  signal,
  onLog,
) => {
  const payload = parseCoverageImportPayload(payloadValue);
  if (signal.aborted) return { ...successfulProcess, cancelled: true };
  const folder = await realpath(payload.folder);
  const reportPath = await realpath(join(folder, payload.reportPath)).catch(
    () => {
      throw new Error(`Coverage file ${payload.reportPath} does not exist`);
    },
  );
  const difference = relative(folder, reportPath).split(sep).join("/");
  if (!difference || difference === ".." || difference.startsWith("../")) {
    throw new Error("Coverage file resolves outside the worktree");
  }
  const information = await stat(reportPath);
  if (!information.isFile()) throw new Error("Coverage file is not a file");
  if (information.size > MAX_REPORT_BYTES) {
    throw new Error("Coverage file exceeds the 64 MiB limit");
  }
  const files = parseCoverageReport(
    await readFile(reportPath, "utf8"),
    payload.format,
  );
  if (!files.length) {
    throw new Error(`Coverage file ${difference} described no files`);
  }
  let changes: Awaited<ReturnType<typeof snapshotCoverageChanges>> = [];
  if (payload.baseBranch) {
    try {
      changes = await snapshotCoverageChanges(
        payload.baseBranch,
        folder,
        Math.min(timeoutMs, 60_000),
        signal,
      );
    } catch (error) {
      await onLog({
        sequence: 0,
        stream: "STDERR",
        message: `Changed-line coverage unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        createdAt: new Date().toISOString(),
      });
    }
  }
  const { summary, data } = buildCoverageReportPayload({
    files,
    folder,
    changes,
  });
  await onLog({
    sequence: 1,
    stream: "SYSTEM",
    message: `Imported ${summary.fileCount} files from ${difference}`,
    createdAt: new Date().toISOString(),
  });
  return {
    ...successfulProcess,
    report: {
      kind: "CODE_COVERAGE",
      status: "READY",
      artifact: null,
      summary,
      data,
      error: null,
    },
    // The waiting workflow step merges this; the per-file lists stay out of it
    // so a large report does not end up copied into every run's session data.
    sessionPatch: { build: { coverageSummary: summary } },
  };
};
