type EventPredicate<T> = (value: T) => boolean;

type Subscriber<T> = {
  predicate?: EventPredicate<T>;
  push: (value: T) => void;
};

export class AsyncEventBus {
  private readonly subscribers = new Map<string, Set<Subscriber<unknown>>>();

  publish<T>(topic: string, value: T): void {
    for (const subscriber of this.subscribers.get(topic) ?? []) {
      const typed = subscriber as Subscriber<T>;
      if (!typed.predicate || typed.predicate(value)) typed.push(value);
    }
  }

  iterate<T>(
    topic: string,
    predicate?: EventPredicate<T>,
  ): AsyncIterableIterator<T> {
    const queue: T[] = [];
    const waiters: Array<(result: IteratorResult<T>) => void> = [];
    let active = true;

    const subscriber: Subscriber<T> = {
      predicate,
      push(value) {
        const waiter = waiters.shift();
        if (waiter) waiter({ value, done: false });
        else queue.push(value);
      },
    };

    const subscribers = this.subscribers.get(topic) ?? new Set();
    subscribers.add(subscriber as Subscriber<unknown>);
    this.subscribers.set(topic, subscribers);

    const close = () => {
      if (!active) return;
      active = false;
      subscribers.delete(subscriber as Subscriber<unknown>);
      if (subscribers.size === 0) this.subscribers.delete(topic);
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined as T, done: true });
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (!active)
          return Promise.resolve({ value: undefined as T, done: true });
        const value = queue.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        return new Promise((resolve) => waiters.push(resolve));
      },
      return() {
        close();
        return Promise.resolve({ value: undefined as T, done: true });
      },
      throw(error?: unknown) {
        close();
        return Promise.reject(error);
      },
    };
  }
}

const globalForAgentEventBus = globalThis as typeof globalThis & {
  agentEventBus?: AsyncEventBus;
};

// Next.js bundles instrumentation and route handlers separately. Keeping the bus on globalThis
// ensures the WebSocket server and HTTP mutations still share one in-process delivery channel.
export const agentEventBus =
  globalForAgentEventBus.agentEventBus ??
  (globalForAgentEventBus.agentEventBus = new AsyncEventBus());

export const AGENT_CHANGED_TOPIC = "agent.changed";
export const agentEventsTopic = (agentId: string) => `agent.${agentId}.events`;
export const agentJobChangedTopic = (jobId: string) => `job.${jobId}.changed`;
export const agentJobLogTopic = (jobId: string) => `job.${jobId}.log`;
export const ccusageCollectionChangedTopic = (collectionId: string) =>
  `ccusage.${collectionId}.changed`;
export const buildDataCollectionChangedTopic = (collectionId: string) =>
  `build-data.${collectionId}.changed`;
export const CODEBASE_CHANGED_TOPIC = "codebase.changed";
export const WORKTREE_CHANGED_TOPIC = "worktree.changed";
export const GITHUB_PIPELINE_STATUS_CHANGED_TOPIC =
  "github.pipeline-status.changed";
export const JIRA_WEBHOOK_DELIVERY_TOPIC = "jira.webhook.delivery";
export const JIRA_TICKET_CHANGED_TOPIC = "jira.ticket.changed";
export const SKILLS_CHANGED_TOPIC = "skills.changed";
export const BUILDS_CHANGED_TOPIC = "builds.changed";
export const IOS_DEVICES_CHANGED_TOPIC = "ios-devices.changed";
export const SIGNING_ASSETS_CHANGED_TOPIC = "signing-assets.changed";
export const PUSH_NOTIFICATIONS_CHANGED_TOPIC = "push-notifications.changed";
export const APP_NOTIFICATIONS_CHANGED_TOPIC = "app-notifications.changed";
export const RUNS_CHANGED_TOPIC = "runs.changed";
export const COMMANDS_CHANGED_TOPIC = "commands.changed";
export const COMMAND_RUNS_CHANGED_TOPIC = "command-runs.changed";
export const COMMAND_RUN_OUTPUT_CHANGED_TOPIC = "command-runs.output.changed";
export const BUILD_DATA_CHANGED_TOPIC = "build-data.changed";
export const MODEL_COST_CATALOG_CHANGED_TOPIC = "model-costs.catalog.changed";
export const TOOL_CALL_AUDIT_CHANGED_TOPIC = "tool-call-audit.changed";
export const commandRunChangedTopic = (runId: string) =>
  `command-run.${runId}.changed`;
export const commandRunOutputTopic = (runId: string) =>
  `command-run.${runId}.output`;
export const runChangedTopic = (runId: string) => `run.${runId}.changed`;
export const runEventTopic = (runId: string) => `run.${runId}.event`;
export const runQuestionTopic = (runId: string) => `run.${runId}.question`;
export const POLLING_CHANGED_TOPIC = "polling.changed";
export const DISK_SPACE_CHANGED_TOPIC = "disk-space.changed";
export const SIDEBAR_STATUS_CHANGED_TOPIC = "sidebar-status.changed";
export const CLI_HEALTH_CHANGED_TOPIC = "cli-health.changed";
export const TAILSCALE_SERVE_CHANGED_TOPIC = "tailscale-serve.changed";
export const tailscaleServeOperationChangedTopic = (operationId: string) =>
  `tailscale-serve.operation.${operationId}.changed`;
export const TELEMETRY_CHANGED_TOPIC = "telemetry.changed";
export const TELEMETRY_SETTINGS_CHANGED_TOPIC = "telemetry.settings.changed";
export const buildTopic = (buildId: string) => `build.${buildId}.changed`;
export const buildLogChunkTopic = (buildId: string) =>
  `build.${buildId}.log-chunk`;
export const skillSyncRunTopic = (runId: string) =>
  `skills.sync.${runId}.changed`;
export const worktreeInspectionTopic = (worktreeId: string) =>
  `worktree.${worktreeId}.inspection`;
