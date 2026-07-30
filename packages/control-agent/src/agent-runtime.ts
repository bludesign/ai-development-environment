import type { AgentConfig } from "./config.js";
import { agentEndpoints, configForEndpoint } from "./config.js";
import { selectAgentEndpoint } from "./endpoint-selection.js";
import {
  DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS,
  MAX_AGENT_HEARTBEAT_INTERVAL_SECONDS,
  MAX_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS,
  MIN_AGENT_HEARTBEAT_INTERVAL_SECONDS,
  MIN_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS,
} from "@ai-development-environment/agent-contract";
import {
  AgentGraphQLClient,
  createAgentSubscriptionClient,
  subscribeToAgentEvents,
} from "./graphql-client.js";
import { collectInventory } from "./inventory.js";
import { JobExecutor } from "./job-executor.js";
import { CodebaseMonitor } from "./codebase-monitor.js";
import { RepositoryCoordinator } from "./repository-coordinator.js";
import { RunManager } from "./runs/run-manager.js";
import { DISK_SPACE_POLL_INTERVAL_SECONDS } from "@ai-development-environment/agent-contract/disk-space";
import { collectAgentDiskSpace } from "./handlers/build-data.js";

function configuredIntervalMs(
  value: number,
  fallbackSeconds: number,
  minSeconds: number,
  maxSeconds: number,
): number {
  return (
    (Number.isInteger(value) && value >= minSeconds && value <= maxSeconds
      ? value
      : fallbackSeconds) * 1_000
  );
}

// Heartbeats are the cheapest signal that the active address stopped working.
// Three in a row is long enough to ride out a restart of the control plane but
// short enough that a laptop leaving the network fails over within a minute.
const UNHEALTHY_HEARTBEAT_FAILURES = 3;

export async function runAgentSession(
  config: AgentConfig,
  signal: AbortSignal,
  onUnhealthy?: () => void,
): Promise<void> {
  const client = new AgentGraphQLClient(
    config.server,
    config.credential,
    10_000,
    config.headers,
  );
  const repositoryCoordinator = new RepositoryCoordinator();
  const executor = new JobExecutor(client, repositoryCoordinator);
  const codebaseMonitor = new CodebaseMonitor(client, repositoryCoordinator);
  const runManager = new RunManager(client);
  let heartbeatIntervalMs = DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS * 1_000;
  let jobReconciliationIntervalMs =
    DEFAULT_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS * 1_000;
  let heartbeatRunning = false;
  let jobReconciliationRunning = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let jobReconciliationTimer: ReturnType<typeof setTimeout> | undefined;
  let codebaseTimer: ReturnType<typeof setTimeout> | undefined;
  let diskSpaceTimer: ReturnType<typeof setTimeout> | undefined;
  let diskSpaceRunning = false;
  let diskSpaceIntervalMs = DISK_SPACE_POLL_INTERVAL_SECONDS * 1_000;
  let startupRecoveryPending = true;
  let heartbeatFailures = 0;
  const interruptedJobs = new Set<string>();

  const reconcileJobs = async (recoverInterrupted: boolean) => {
    let jobs;
    try {
      jobs = await client.pendingJobs(config.agentId);
    } catch (error) {
      console.error(
        "Durable job reconciliation failed:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
    await Promise.all(
      jobs.map(async (job) => {
        if (job.status === "CANCELLED") {
          executor.cancel(job.id);
          return;
        }
        if (job.status === "CANCELLING") {
          if (!executor.cancel(job.id)) {
            await client.completeJob(job.id, "CANCELLED");
          }
          return;
        }
        if (
          job.status !== "RUNNING" ||
          (!recoverInterrupted && !interruptedJobs.has(job.id))
        ) {
          executor.execute(job);
          return;
        }
        interruptedJobs.add(job.id);
        try {
          await client.completeJob(
            job.id,
            "FAILED",
            undefined,
            "Agent service restarted while this job was running",
          );
          interruptedJobs.delete(job.id);
        } catch (error) {
          console.error(
            `Could not reconcile interrupted job ${job.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }),
    );
    return true;
  };

  const refreshCadence = async () => {
    try {
      const settings = await client.cadenceSettings(config.agentId);
      heartbeatIntervalMs = configuredIntervalMs(
        settings.heartbeatIntervalSeconds,
        DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS,
        MIN_AGENT_HEARTBEAT_INTERVAL_SECONDS,
        MAX_AGENT_HEARTBEAT_INTERVAL_SECONDS,
      );
      jobReconciliationIntervalMs = configuredIntervalMs(
        settings.jobReconciliationIntervalSeconds,
        DEFAULT_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS,
        MIN_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS,
        MAX_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS,
      );
    } catch (error) {
      console.error(
        "Agent cadence configuration failed:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  const scheduleHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (!signal.aborted) {
      heartbeatTimer = setTimeout(() => void heartbeat(), heartbeatIntervalMs);
    }
  };
  const heartbeat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    try {
      await client.heartbeat(collectInventory());
      heartbeatFailures = 0;
    } catch (error) {
      heartbeatFailures += 1;
      console.error(
        "Heartbeat failed:",
        error instanceof Error ? error.message : error,
      );
      if (heartbeatFailures >= UNHEALTHY_HEARTBEAT_FAILURES && onUnhealthy) {
        heartbeatFailures = 0;
        // Aborts this session; the supervisor then re-selects an endpoint.
        onUnhealthy();
      }
    } finally {
      heartbeatRunning = false;
      scheduleHeartbeat();
    }
  };

  const scheduleJobReconciliation = () => {
    if (jobReconciliationTimer) clearTimeout(jobReconciliationTimer);
    if (!signal.aborted) {
      jobReconciliationTimer = setTimeout(
        () => void runJobReconciliation(),
        jobReconciliationIntervalMs,
      );
    }
  };
  const runJobReconciliation = async () => {
    if (jobReconciliationRunning) return;
    jobReconciliationRunning = true;
    if (jobReconciliationTimer) clearTimeout(jobReconciliationTimer);
    jobReconciliationTimer = undefined;
    try {
      if (await reconcileJobs(startupRecoveryPending)) {
        startupRecoveryPending = false;
      }
    } finally {
      jobReconciliationRunning = false;
      scheduleJobReconciliation();
    }
  };

  let codebaseReconciling = false;
  let codebaseReconcilePending = false;
  const reconcileCodebases = async () => {
    if (codebaseReconciling) {
      codebaseReconcilePending = true;
      return;
    }
    codebaseReconciling = true;
    if (codebaseTimer) clearTimeout(codebaseTimer);
    codebaseTimer = undefined;
    try {
      await codebaseMonitor.reconcile(signal);
    } finally {
      codebaseReconciling = false;
      if (!signal.aborted) {
        if (codebaseReconcilePending) {
          codebaseReconcilePending = false;
          void reconcileCodebases();
        } else {
          codebaseTimer = setTimeout(
            () => void reconcileCodebases(),
            codebaseMonitor.reconcileIntervalMs,
          );
        }
      }
    }
  };
  const requestCodebaseReconcile = () => {
    if (signal.aborted) return;
    if (codebaseReconciling) {
      codebaseReconcilePending = true;
      return;
    }
    if (codebaseTimer) clearTimeout(codebaseTimer);
    codebaseTimer = undefined;
    void reconcileCodebases();
  };

  const scheduleDiskSpacePoll = () => {
    if (diskSpaceTimer) clearTimeout(diskSpaceTimer);
    if (!signal.aborted) {
      diskSpaceTimer = setTimeout(
        () => void runDiskSpacePoll(),
        diskSpaceIntervalMs,
      );
    }
  };
  const runDiskSpacePoll = async () => {
    if (diskSpaceRunning || signal.aborted) return;
    diskSpaceRunning = true;
    if (diskSpaceTimer) clearTimeout(diskSpaceTimer);
    diskSpaceTimer = undefined;
    try {
      const configuration = await client.diskSpaceConfiguration();
      diskSpaceIntervalMs = Math.max(
        1_000,
        configuration.pollIntervalSeconds * 1_000,
      );
      if (configuration.enabled) {
        const report = await collectAgentDiskSpace(configuration, signal);
        await client.reportDiskSpace(report);
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error(
          "Disk space poll failed:",
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
      diskSpaceRunning = false;
      scheduleDiskSpacePoll();
    }
  };

  await refreshCadence();
  await heartbeat();
  await runJobReconciliation();
  await runManager.start();
  void reconcileCodebases();
  void runDiskSpacePoll();

  const subscriptionClient = createAgentSubscriptionClient(config);
  const unsubscribe = subscribeToAgentEvents(
    subscriptionClient,
    config.agentId,
    (event) => {
      if (event.type === "JOB_AVAILABLE") executor.execute(event.job);
      else if (event.type === "JOB_CANCEL_REQUESTED") {
        executor.cancel(event.job.id);
      } else if (event.type === "CODEBASE_RECONCILE_REQUESTED") {
        requestCodebaseReconcile();
      } else if (event.type === "RUN_COMMAND_AVAILABLE") {
        runManager.execute(event.runCommand);
      } else if (event.type === "DISK_SPACE_POLL_REQUESTED") {
        void runDiskSpacePoll();
      } else {
        void refreshCadence().then(() => {
          scheduleHeartbeat();
          scheduleJobReconciliation();
          requestCodebaseReconcile();
          void runDiskSpacePoll();
        });
      }
    },
  );

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  if (jobReconciliationTimer) clearTimeout(jobReconciliationTimer);
  if (codebaseTimer) clearTimeout(codebaseTimer);
  if (diskSpaceTimer) clearTimeout(diskSpaceTimer);
  unsubscribe();
  await subscriptionClient.dispose();
  await executor.cancelAll();
  await runManager.close();
}

/**
 * Runs the agent against whichever configured endpoint is answering. With a
 * single endpoint this is one uninterrupted session; with a local and a remote
 * address the session is torn down and rebuilt on the other address whenever
 * the active one stops responding.
 */
export async function runAgent(
  config: AgentConfig,
  signal: AbortSignal,
): Promise<void> {
  const failoverEnabled = agentEndpoints(config).length > 1;
  while (!signal.aborted) {
    const endpoint = await selectAgentEndpoint(config, signal);
    if (signal.aborted) break;
    if (failoverEnabled) {
      console.log(
        `Using the ${endpoint.kind} control plane at ${endpoint.server}`,
      );
    }
    const session = new AbortController();
    const abortSession = () => session.abort();
    signal.addEventListener("abort", abortSession, { once: true });
    try {
      await runAgentSession(
        configForEndpoint(config, endpoint),
        session.signal,
        failoverEnabled
          ? () => {
              console.log(
                `The ${endpoint.kind} control plane stopped responding; switching endpoints`,
              );
              session.abort();
            }
          : undefined,
      );
    } finally {
      signal.removeEventListener("abort", abortSession);
    }
  }
}
