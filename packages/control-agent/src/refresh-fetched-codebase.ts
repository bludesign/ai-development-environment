import type { CodebaseSnapshot } from "@ai-development-environment/agent-contract/codebases";

import type { AgentGraphQLClient } from "./graphql-client.js";
import { discoverWorktrees } from "./handlers/worktrees.js";

export type FetchedCodebaseRefresh = {
  codebaseId: string;
  snapshot: CodebaseSnapshot;
  fetchAttemptedAt: string;
  fetchError: string | null;
};

/** Called by the fetch handler while its repository coordinator lock is held. */
export async function refreshFetchedCodebase(
  client: Pick<
    AgentGraphQLClient,
    "agentCodebases" | "reportCodebaseStatuses" | "reportWorktrees"
  >,
  input: FetchedCodebaseRefresh,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const registration = (await client.agentCodebases()).find(
    (codebase) => codebase.id === input.codebaseId,
  );
  if (!registration) throw new Error("Codebase is no longer registered");
  if (input.snapshot.availability !== "AVAILABLE") {
    throw new Error(input.snapshot.error || "Codebase is unavailable");
  }
  signal.throwIfAborted();
  const inventory = await discoverWorktrees(
    input.snapshot.folder,
    new Map(
      registration.worktrees.map((worktree) => [
        worktree.gitDirectory,
        worktree.baseBranchOverride,
      ]),
    ),
    registration.defaultBranch,
    Math.min(timeoutMs, 30_000),
    signal,
  );
  if (!inventory.complete) {
    throw new Error("Worktree inventory refresh was incomplete");
  }
  signal.throwIfAborted();
  await client.reportCodebaseStatuses([
    { codebaseId: input.codebaseId, snapshot: input.snapshot },
  ]);
  signal.throwIfAborted();
  await client.reportWorktrees([
    {
      codebaseId: input.codebaseId,
      ...inventory,
      fetchedAt: input.snapshot.fetchedAt,
      fetchAttemptedAt: input.fetchAttemptedAt,
      fetchError: input.fetchError,
    },
  ]);
  signal.throwIfAborted();
  return new Date().toISOString();
}
