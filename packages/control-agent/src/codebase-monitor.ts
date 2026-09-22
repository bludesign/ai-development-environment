import {
  DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS,
} from "@ai-development-environment/agent-contract/codebases";
import type { CodebaseWorktreeReport } from "@ai-development-environment/agent-contract/worktrees";

import type { AgentGraphQLClient } from "./graphql-client.js";
import {
  inspectCodebase,
  updateBaseBranchAfterFetch,
} from "./handlers/codebases.js";
import { discoverWorktrees } from "./handlers/worktrees.js";
import { captureCommand } from "./capture-command.js";
import { RepositoryCoordinator } from "./repository-coordinator.js";

const INSPECTION_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

export class CodebaseMonitor {
  private running = false;
  private intervalMs = DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS * 1_000;

  constructor(
    private readonly client: AgentGraphQLClient,
    private readonly repositoryCoordinator = new RepositoryCoordinator(),
  ) {}

  get reconcileIntervalMs(): number {
    return this.intervalMs;
  }

  async reconcile(signal: AbortSignal): Promise<void> {
    if (this.running || signal.aborted) return;
    this.running = true;
    try {
      const configuration = await this.client.agentCodebaseConfiguration();
      if (
        Number.isInteger(configuration.refreshIntervalSeconds) &&
        configuration.refreshIntervalSeconds >=
          MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS &&
        configuration.refreshIntervalSeconds <=
          MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS
      ) {
        this.intervalMs = configuration.refreshIntervalSeconds * 1_000;
      }
      const codebases = configuration.codebases;
      for (let index = 0; index < codebases.length; index += CONCURRENCY) {
        const batch = codebases.slice(index, index + CONCURRENCY);
        await Promise.all(
          batch.map((codebase) =>
            this.repositoryCoordinator.run(codebase.id, async () => {
              let snapshot = await inspectCodebase(
                codebase.folder,
                INSPECTION_TIMEOUT_MS,
                signal,
                codebase.canonicalOrigin,
              );
              let fetchAttemptedAt: string | null = null;
              let fetchError: string | null = null;
              const fetchedAt = Math.max(
                snapshot.fetchedAt ? new Date(snapshot.fetchedAt).getTime() : 0,
                codebase.lastFetchAttemptAt
                  ? new Date(codebase.lastFetchAttemptAt).getTime()
                  : 0,
              );
              const fetchDue =
                snapshot.availability === "AVAILABLE" &&
                Date.now() - fetchedAt >=
                  configuration.fetchIntervalSeconds * 1_000;
              if (fetchDue && !signal.aborted) {
                fetchAttemptedAt = new Date().toISOString();
                const fetchResult = await captureCommand({
                  command: "git",
                  args: ["-C", codebase.folder, "fetch", "origin"],
                  timeoutMs: 300_000,
                  signal,
                  env: {
                    ...process.env,
                    GIT_TERMINAL_PROMPT: "0",
                    GIT_OPTIONAL_LOCKS: "0",
                  },
                });
                if (fetchResult.exitCode === 0) {
                  if (
                    codebase.keepBaseBranchUpToDate &&
                    codebase.defaultBranch
                  ) {
                    await updateBaseBranchAfterFetch(
                      codebase.folder,
                      codebase.defaultBranch,
                      INSPECTION_TIMEOUT_MS,
                      signal,
                    );
                  }
                  snapshot = await inspectCodebase(
                    codebase.folder,
                    INSPECTION_TIMEOUT_MS,
                    signal,
                    codebase.canonicalOrigin,
                  );
                } else {
                  fetchError = (fetchResult.stderr || "Git fetch failed")
                    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
                    .slice(0, 2_000);
                }
              }
              let inventory: Omit<
                CodebaseWorktreeReport,
                "codebaseId" | "fetchedAt" | "fetchAttemptedAt" | "fetchError"
              >;
              try {
                inventory = await discoverWorktrees(
                  codebase.folder,
                  new Map(
                    codebase.worktrees.map((worktree) => [
                      worktree.gitDirectory,
                      worktree.baseBranchOverride,
                    ]),
                  ),
                  codebase.defaultBranch,
                  INSPECTION_TIMEOUT_MS,
                  signal,
                );
              } catch (error) {
                inventory = {
                  complete: false,
                  defaultBranch: null,
                  localBranches: [],
                  remoteBranches: [],
                  worktrees: [],
                };
                fetchError ??=
                  error instanceof Error
                    ? error.message.slice(0, 2_000)
                    : String(error);
              }
              // Keep persistence under the repository lock too: a delayed
              // inventory report must not overwrite a newer manual fetch.
              await this.client.reportCodebaseStatuses([
                { codebaseId: codebase.id, snapshot },
              ]);
              await this.client.reportWorktrees([
                {
                  codebaseId: codebase.id,
                  ...inventory,
                  fetchedAt: snapshot.fetchedAt,
                  fetchAttemptedAt,
                  fetchError,
                },
              ]);
            }),
          ),
        );
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error(
          "Codebase status reconciliation failed:",
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
      this.running = false;
    }
  }
}
