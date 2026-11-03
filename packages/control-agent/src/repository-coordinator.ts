type OperationKind = "exclusive" | "inspection" | "reconciliation";

type ReconciliationContext = {
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
};

type RepositoryQueue = {
  inspections: number;
  reconciliation: boolean;
  exclusive: boolean;
  exclusiveReconciliationPhase: (() => void) | null;
  pending: Array<{ kind: OperationKind; start: () => void }>;
};

export class RepositoryCoordinator {
  private readonly queues = new Map<string, RepositoryQueue>();

  run<T>(
    key: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(key, "exclusive", () => task(), signal);
  }

  /** Only read-only worktree inspection jobs may overlap reconciliation. */
  runInspection<T>(
    key: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(key, "inspection", () => task(), signal);
  }

  /** Keep reconciliation and its reports ordered with all user mutations. */
  runReconciliation<T>(
    key: string,
    task: (context: ReconciliationContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(
      key,
      "reconciliation",
      (queue) =>
        task({
          runExclusive: (exclusiveTask) =>
            this.runReconciliationExclusive(key, queue, exclusiveTask),
        }),
      signal,
    );
  }

  private runReconciliationExclusive<T>(
    key: string,
    queue: RepositoryQueue,
    task: () => Promise<T>,
  ): Promise<T> {
    if (!queue.reconciliation || queue.exclusiveReconciliationPhase) {
      return Promise.reject(new Error("Invalid reconciliation phase"));
    }
    return new Promise<T>((resolve, reject) => {
      const complete = () => {
        queue.exclusiveReconciliationPhase = null;
        queue.exclusive = false;
        this.drain(key, queue);
      };
      queue.exclusiveReconciliationPhase = () => {
        void Promise.resolve()
          .then(task)
          .then(
            (result) => {
              complete();
              resolve(result);
            },
            (error: unknown) => {
              complete();
              reject(error);
            },
          );
      };
      this.drain(key, queue);
    });
  }

  private enqueue<T>(
    key: string,
    kind: OperationKind,
    task: (queue: RepositoryQueue) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let queue = this.queues.get(key);
    if (!queue) {
      queue = {
        inspections: 0,
        reconciliation: false,
        exclusive: false,
        exclusiveReconciliationPhase: null,
        pending: [],
      };
      this.queues.set(key, queue);
    }
    const repositoryQueue = queue;
    return new Promise<T>((resolve, reject) => {
      let pending = true;
      const complete = () => {
        if (kind === "inspection") repositoryQueue.inspections -= 1;
        else if (kind === "reconciliation")
          repositoryQueue.reconciliation = false;
        else repositoryQueue.exclusive = false;
        this.drain(key, repositoryQueue);
      };
      const abort = () => {
        if (!pending) return;
        pending = false;
        const index = repositoryQueue.pending.indexOf(operation);
        if (index !== -1) repositoryQueue.pending.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
        this.drain(key, repositoryQueue);
      };
      const operation: RepositoryQueue["pending"][number] = {
        kind,
        start: () => {
          pending = false;
          // An active handler owns its lease until it settles, even if aborted.
          signal?.removeEventListener("abort", abort);
          void Promise.resolve()
            .then(() => {
              signal?.throwIfAborted();
              return task(repositoryQueue);
            })
            .then(
              (result) => {
                complete();
                resolve(result);
              },
              (error: unknown) => {
                complete();
                reject(error);
              },
            );
        },
      };
      repositoryQueue.pending.push(operation);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.drain(key, repositoryQueue);
    });
  }

  private drain(key: string, queue: RepositoryQueue): void {
    if (queue.exclusiveReconciliationPhase) {
      // Reconciliation retains its place ahead of queued user mutations while
      // waiting for active inspections to finish before touching the checkout.
      if (!queue.exclusive && queue.inspections === 0) {
        queue.exclusive = true;
        queue.exclusiveReconciliationPhase();
      }
      return;
    }
    while (!queue.exclusive && queue.pending.length) {
      const next = queue.pending[0]!;
      if (
        (next.kind === "exclusive" &&
          (queue.inspections > 0 || queue.reconciliation)) ||
        (next.kind === "reconciliation" && queue.reconciliation)
      ) {
        // Preserve queue order so incoming inspections cannot starve a writer.
        return;
      }
      queue.pending.shift();
      if (next.kind === "inspection") queue.inspections += 1;
      else if (next.kind === "reconciliation") queue.reconciliation = true;
      else queue.exclusive = true;
      next.start();
    }
    if (
      !queue.exclusive &&
      !queue.reconciliation &&
      queue.inspections === 0 &&
      queue.pending.length === 0
    ) {
      this.queues.delete(key);
    }
  }
}
