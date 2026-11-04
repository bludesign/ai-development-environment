import {
  DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS,
} from "@ai-development-environment/agent-contract/codebases";
import type { CodebaseWorktreeReport } from "@ai-development-environment/agent-contract/worktrees";

import type {
  AgentGraphQLClient,
  AgentCodebaseRegistration,
} from "./graphql-client.js";
import {
  inspectCodebase,
  updateBaseBranchAfterFetch,
} from "./handlers/codebases.js";
import { discoverWorktrees } from "./handlers/worktrees.js";
import { captureCommand } from "./capture-command.js";
import { RepositoryCoordinator } from "./repository-coordinator.js";
import { scanLocalBranches } from "./handlers/local-branches.js";
import { withRepositoryMetadata } from "./repository-metadata.js";

const INSPECTION_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

export class CodebaseMonitor {
  private running = false;
  private intervalMs = DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS * 1_000;

  constructor(
    private readonly client: AgentGraphQLClient,
    private readonly repositoryCoordinator = new RepositoryCoordinator(),
    private readonly agentId?: string,
  ) {}

  get reconcileIntervalMs(): number {
    return this.intervalMs;
  }

  private inspectRoot(
    codebase: AgentCodebaseRegistration,
    signal: AbortSignal,
  ) {
    const inspect = () =>
      inspectCodebase(
        codebase.folder,
        INSPECTION_TIMEOUT_MS,
        signal,
        codebase.canonicalOrigin,
      );
    const root = codebase.worktrees.find(
      (worktree) => worktree.folder === codebase.folder,
    );
    return this.agentId && root
      ? this.repositoryCoordinator.withResources(
          [
            {
              kind: "WORKTREE",
              key: `${this.agentId}:worktree:${root.gitDirectory}`,
              agentId: this.agentId,
              codebaseId: codebase.id,
              mode: "READ",
            },
            {
              kind: "PATH",
              key: root.folder,
              path: root.folder,
              agentId: this.agentId,
              codebaseId: codebase.id,
              mode: "READ",
            },
          ],
          inspect,
          signal,
        )
      : inspect();
  }

  private reconcileCodebase(
    codebase: AgentCodebaseRegistration,
    signal: AbortSignal,
    task: (
      runExclusive: (task: () => Promise<unknown>) => Promise<unknown>,
    ) => Promise<void>,
  ): Promise<void> {
    if (!this.agentId)
      return this.repositoryCoordinator.runReconciliation(
        codebase.id,
        ({ runExclusive }) => task(runExclusive),
        signal,
      );
    return task(async (exclusiveTask) => {
      const root = codebase.worktrees.find(
        (worktree) => worktree.folder === codebase.folder,
      );
      if (!root) return;
      const grant = await this.repositoryCoordinator.tryWithResources(
        [
          {
            kind: "WORKTREE",
            key: `${this.agentId}:worktree:${root.gitDirectory}`,
            agentId: this.agentId,
            codebaseId: codebase.id,
            mode: "WRITE",
          },
          {
            kind: "PATH",
            key: root.folder,
            path: root.folder,
            agentId: this.agentId,
            codebaseId: codebase.id,
            mode: "WRITE",
          },
        ],
        exclusiveTask,
        signal,
      );
      return grant.ran ? grant.result : undefined;
    });
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
            this.reconcileCodebase(codebase, signal, async (runExclusive) => {
              const observedAt = new Date().toISOString();
              let snapshot = await this.inspectRoot(codebase, signal);
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
                const fetchResult = await withRepositoryMetadata(
                  codebase.folder,
                  () =>
                    captureCommand({
                      command: "git",
                      args: ["-C", codebase.folder, "fetch", "origin"],
                      timeoutMs: 300_000,
                      signal,
                      env: {
                        ...process.env,
                        GIT_TERMINAL_PROMPT: "0",
                        GIT_OPTIONAL_LOCKS: "0",
                      },
                    }),
                  signal,
                );
                if (fetchResult.exitCode === 0) {
                  if (
                    codebase.keepBaseBranchUpToDate &&
                    codebase.defaultBranch
                  ) {
                    const baseBranch = codebase.defaultBranch;
                    await runExclusive(() =>
                      updateBaseBranchAfterFetch(
                        codebase.folder,
                        baseBranch,
                        INSPECTION_TIMEOUT_MS,
                        signal,
                      ),
                    );
                  }
                  snapshot = await this.inspectRoot(codebase, signal);
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
                  ...(this.agentId
                    ? ([
                        (
                          gitDirectory: string,
                          task: () => Promise<
                            import("@ai-development-environment/agent-contract/worktrees").WorktreeInventoryItem
                          >,
                          folder: string,
                        ) =>
                          this.repositoryCoordinator.withResources(
                            [
                              {
                                kind: "WORKTREE",
                                key: `${this.agentId}:worktree:${gitDirectory}`,
                                agentId: this.agentId,
                                codebaseId: codebase.id,
                                mode: "READ",
                              },
                              {
                                kind: "PATH",
                                key: folder,
                                path: folder,
                                agentId: this.agentId,
                                codebaseId: codebase.id,
                                mode: "READ",
                              },
                            ],
                            task,
                            signal,
                          ),
                      ] as const)
                    : []),
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
              // Reports carry observation timestamps; publishing them does not
              // retain checkout leases while waiting for the control plane.
              const localBranchInventoryAttemptedAt = new Date().toISOString();
              let localBranchInventory = null;
              let localBranchInventoryError = null;
              try {
                if (snapshot.availability !== "AVAILABLE")
                  throw new Error(snapshot.error || "Codebase is unavailable");
                localBranchInventory = await scanLocalBranches(
                  codebase.folder,
                  INSPECTION_TIMEOUT_MS,
                  signal,
                );
              } catch (error) {
                localBranchInventoryError =
                  error instanceof Error
                    ? error.message.slice(0, 2_000)
                    : String(error).slice(0, 2_000);
              }
              if (signal.aborted) return;
              await this.client.reportCodebaseStatuses([
                {
                  codebaseId: codebase.id,
                  snapshot,
                  localBranchInventory,
                  localBranchInventoryError,
                  localBranchInventoryAttemptedAt,
                },
              ]);
              await this.client.reportWorktrees([
                {
                  codebaseId: codebase.id,
                  ...inventory,
                  observedAt,
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
