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
export const CODEBASE_CHANGED_TOPIC = "codebase.changed";
export const WORKTREE_CHANGED_TOPIC = "worktree.changed";
export const worktreeInspectionTopic = (worktreeId: string) =>
  `worktree.${worktreeId}.inspection`;
