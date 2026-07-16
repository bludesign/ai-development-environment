import {
  DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  type CodebaseStatusReport,
} from "@ai-development-environment/agent-contract/codebases";

import type { AgentGraphQLClient } from "./graphql-client.js";
import { inspectCodebase } from "./handlers/codebases.js";

const INSPECTION_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

export class CodebaseMonitor {
  private running = false;
  private intervalMs = DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS * 1_000;

  constructor(private readonly client: AgentGraphQLClient) {}

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
      const reports: CodebaseStatusReport[] = [];
      for (let index = 0; index < codebases.length; index += CONCURRENCY) {
        const batch = codebases.slice(index, index + CONCURRENCY);
        reports.push(
          ...(await Promise.all(
            batch.map(async (codebase) => ({
              codebaseId: codebase.id,
              snapshot: await inspectCodebase(
                codebase.folder,
                INSPECTION_TIMEOUT_MS,
                signal,
                codebase.canonicalOrigin,
              ),
            })),
          )),
        );
      }
      for (let index = 0; index < reports.length; index += 500) {
        await this.client.reportCodebaseStatuses(
          reports.slice(index, index + 500),
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
