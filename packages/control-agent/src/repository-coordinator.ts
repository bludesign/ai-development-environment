import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  normalizeOperationResources,
  operationDescriptorsConflict,
  type OperationDescriptor,
  type OperationResource,
} from "@ai-development-environment/agent-contract/operation-resources";

type ResourceTask = {
  descriptor: OperationDescriptor;
  owner: symbol;
  start: () => void;
  fail: (error: Error) => void;
};

/** Resolve aliases even when a build's output directory has not been created. */
export async function canonicalResourcePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if ((await lstat(absolute)).isSymbolicLink())
        return canonicalResourcePath(
          resolve(dirname(absolute), await readlink(absolute)),
        );
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT")
        throw linkError;
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalResourcePath(parent), basename(absolute));
  }
}

type OperationKind = "exclusive" | "inspection" | "reconciliation" | "build";

type ReconciliationContext = {
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
};

type RepositoryQueue = {
  inspections: number;
  reconciliation: boolean;
  exclusive: boolean;
  build: boolean;
  exclusiveReconciliationPhase: (() => void) | null;
  pending: Array<{ kind: OperationKind; start: () => void }>;
};

export class RepositoryCoordinator {
  private readonly queues = new Map<string, RepositoryQueue>();
  private readonly resourceOwners = new AsyncLocalStorage<symbol>();
  private readonly resourceActive = new Set<ResourceTask>();
  private readonly resourcePending: ResourceTask[] = [];

  private async descriptor(
    resources: readonly OperationResource[],
  ): Promise<OperationDescriptor> {
    return {
      version: 1,
      resources: normalizeOperationResources(
        await Promise.all(
          resources.map(async (resource) => {
            if (resource.kind !== "PATH") return resource;
            const path = await canonicalResourcePath(
              resource.path ?? resource.key,
            );
            return { ...resource, key: path, path };
          }),
        ),
      ),
    };
  }

  /** Acquire an entire resource set atomically; unrelated waiters can proceed. */
  async withResources<T>(
    resources: readonly OperationResource[],
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const descriptor = await this.descriptor(resources);
    signal?.throwIfAborted();
    return this.enqueueResources(descriptor, task, signal);
  }

  /** Background checkout maintenance should skip a busy worktree, not wait. */
  async tryWithResources<T>(
    resources: readonly OperationResource[],
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ ran: false } | { ran: true; result: T }> {
    const descriptor = await this.descriptor(resources);
    const owner = this.resourceOwners.getStore();
    if (
      [...this.resourceActive, ...this.resourcePending].some(
        (entry) =>
          entry.owner !== owner &&
          operationDescriptorsConflict(entry.descriptor, descriptor),
      )
    )
      return { ran: false };
    return {
      ran: true,
      result: await this.enqueueResources(descriptor, task, signal),
    };
  }

  private enqueueResources<T>(
    descriptor: OperationDescriptor,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const owner = this.resourceOwners.getStore() ?? Symbol("operation");
    return new Promise<T>((resolve, reject) => {
      let pending = true;
      const abort = () => {
        if (!pending) return;
        pending = false;
        const index = this.resourcePending.indexOf(entry);
        if (index >= 0) this.resourcePending.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
        this.drainResources();
      };
      const entry: ResourceTask = {
        descriptor,
        owner,
        fail: (error) => {
          pending = false;
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        start: () => {
          pending = false;
          signal?.removeEventListener("abort", abort);
          this.resourceActive.add(entry);
          void this.resourceOwners
            .run(owner, async () => {
              signal?.throwIfAborted();
              return task();
            })
            .then(
              (result) => {
                this.resourceActive.delete(entry);
                this.drainResources();
                resolve(result);
              },
              (error: unknown) => {
                this.resourceActive.delete(entry);
                this.drainResources();
                reject(error);
              },
            );
        },
      };
      this.resourcePending.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.drainResources();
    });
  }

  private drainResources(): void {
    for (let index = 0; index < this.resourcePending.length;) {
      const next = this.resourcePending[index]!;
      const active = [...this.resourceActive].filter(
        (entry) => entry.owner !== next.owner,
      );
      if (
        active.some((entry) =>
          operationDescriptorsConflict(entry.descriptor, next.descriptor),
        )
      ) {
        if (this.hasResourceWaitCycle(next.owner)) {
          this.resourcePending.splice(index, 1);
          next.fail(
            new Error(
              "Resource lock expansion would deadlock with another operation; use separate build output directories",
            ),
          );
          continue;
        }
        index += 1;
        continue;
      }
      const heldByOwner = [...this.resourceActive].filter(
        (entry) => entry.owner === next.owner,
      );
      const blockedByEarlier = this.resourcePending
        .slice(0, index)
        .some((earlier) => {
          if (
            earlier.owner === next.owner ||
            !operationDescriptorsConflict(earlier.descriptor, next.descriptor)
          )
            return false;
          // A nested claim must not wait on a writer that is waiting for its owner.
          if (
            heldByOwner.some((held) =>
              operationDescriptorsConflict(held.descriptor, earlier.descriptor),
            )
          )
            return false;
          // Keep inspections responsive while a build prevents the queued writer.
          return !(
            next.descriptor.resources.every(
              (resource) =>
                resource.mode === "READ" &&
                !resource.key.includes(":build-stability:"),
            ) &&
            active.some(
              (held) =>
                held.descriptor.resources.some(
                  (resource) => resource.mode === "BUILD",
                ) &&
                operationDescriptorsConflict(
                  held.descriptor,
                  earlier.descriptor,
                ),
            )
          );
        });
      if (blockedByEarlier) {
        index += 1;
        continue;
      }
      this.resourcePending.splice(index, 1);
      next.start();
    }
  }

  private hasResourceWaitCycle(owner: symbol): boolean {
    const edges = new Map<symbol, Set<symbol>>();
    for (const pending of this.resourcePending) {
      for (const active of this.resourceActive) {
        if (
          active.owner === pending.owner ||
          !operationDescriptorsConflict(pending.descriptor, active.descriptor)
        )
          continue;
        const waiting = edges.get(pending.owner) ?? new Set<symbol>();
        waiting.add(active.owner);
        edges.set(pending.owner, waiting);
      }
    }
    const visit = (current: symbol, seen: Set<symbol>): boolean => {
      if (seen.has(current)) return false;
      seen.add(current);
      for (const target of edges.get(current) ?? []) {
        if (target === owner || visit(target, seen)) return true;
      }
      return false;
    };
    return visit(owner, new Set());
  }

  run<T>(
    key: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(key, "exclusive", () => task(), signal);
  }

  /** Keep source files stable during builds while allowing live inspections. */
  runBuild<T>(
    key: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(key, "build", () => task(), signal);
  }

  /** Read-only worktree inspections may overlap builds and reconciliation. */
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
        build: false,
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
        else if (kind === "build") repositoryQueue.build = false;
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
    while (!queue.exclusive && !queue.build && queue.pending.length) {
      const next = queue.pending[0]!;
      if (
        (next.kind === "exclusive" &&
          (queue.inspections > 0 || queue.reconciliation)) ||
        (next.kind === "build" && queue.reconciliation) ||
        (next.kind === "reconciliation" && queue.reconciliation)
      ) {
        // Preserve queue order so incoming inspections cannot starve a writer.
        return;
      }
      queue.pending.shift();
      if (next.kind === "inspection") queue.inspections += 1;
      else if (next.kind === "reconciliation") queue.reconciliation = true;
      else if (next.kind === "build") queue.build = true;
      else queue.exclusive = true;
      next.start();
    }
    if (queue.build) {
      // Mutations can wait for a long build. Let inspections pass them until
      // the build settles, then resume FIFO ordering so writers cannot starve.
      const inspections = queue.pending.filter(
        (operation) => operation.kind === "inspection",
      );
      queue.pending = queue.pending.filter(
        (operation) => operation.kind !== "inspection",
      );
      for (const inspection of inspections) {
        queue.inspections += 1;
        inspection.start();
      }
    }
    if (
      !queue.exclusive &&
      !queue.build &&
      !queue.reconciliation &&
      queue.inspections === 0 &&
      queue.pending.length === 0
    ) {
      this.queues.delete(key);
    }
  }
}
