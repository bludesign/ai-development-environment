"use client";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "./control-plane-client";

export const GITHUB_CONFIGURATION_QUERY = `query GitHubPageConfiguration { githubSettings { tokenConfigured defaultJiraKeyRegex defaultMergeMethod emptyMergeCommitDescription defaultMoveTicketToDone defaultDeleteWorktree updatedAt } }`;
type ProviderScope = string | readonly string[];
const cache = new Map<
  string,
  { providers: readonly string[]; value: unknown }
>();
const revisions = new Map<string, number>();
let resetRevision = 0;
const listeners = new Set<{
  providers: readonly string[] | null;
  listener: () => void;
}>();
let disposeSubscription: (() => void) | null = null;
/**
 * The server answers a new subscription with ALL once it is listening, so that
 * a read made before then cannot miss a change. Whatever was read while the
 * subscription was being set up is moments old, so a prompt replay is not
 * treated as a change. One that arrives late, after a slow connection, still
 * is.
 */
const REGISTRATION_REPLAY_WINDOW_MS = 5_000;

export function clearIntegrationConfigurationCache(provider?: string) {
  if (!provider) {
    cache.clear();
    resetRevision += 1;
    return;
  }
  for (const [key, entry] of cache)
    if (entry.providers.includes(provider)) cache.delete(key);
  revisions.set(provider, (revisions.get(provider) ?? 0) + 1);
}

export async function readIntegrationConfiguration<T>(
  scope: ProviderScope,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const providers = typeof scope === "string" ? [scope] : scope;
  const key = JSON.stringify([providers, query]);
  for (;;) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    const existing = cache.get(key);
    if (existing) return existing.value as T;
    const reset = resetRevision;
    const readRevisions = providers.map((provider) => revisions.get(provider));
    const value = await controlPlaneRequest<T>(query, undefined, options);
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (
      reset !== resetRevision ||
      providers.some(
        (provider, index) => revisions.get(provider) !== readRevisions[index],
      )
    )
      continue;
    cache.set(key, { providers, value });
    return value;
  }
}

export function subscribeIntegrationConfiguration(
  scope: ProviderScope | null,
  listener: () => void,
): () => void {
  const entry = {
    providers: typeof scope === "string" ? [scope] : scope,
    listener,
  };
  listeners.add(entry);
  if (!disposeSubscription) {
    const subscribedAt = Date.now();
    let replayPending = true;
    const invalidate = (changed?: string) => {
      clearIntegrationConfigurationCache(changed);
      for (const item of listeners)
        if (!changed || !item.providers || item.providers.includes(changed))
          item.listener();
    };
    const dispose = controlPlaneSubscriptions().subscribe<{
      integrationConfigurationChanged: string;
    }>(
      {
        query:
          "subscription IntegrationConfigurationChanged { integrationConfigurationChanged }",
      },
      {
        next: (result) => {
          const changed = result.data?.integrationConfigurationChanged;
          const promptReplay =
            replayPending &&
            changed === "ALL" &&
            Date.now() - subscribedAt < REGISTRATION_REPLAY_WINDOW_MS;
          replayPending = false;
          // Every consumer read its configuration as it subscribed. Reading it
          // all again here would repeat those reads on each page load.
          if (promptReplay) return;
          invalidate(changed === "ALL" ? undefined : changed);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const recover = onControlPlaneRecovery((event) => {
      // The subscription emits ALL after its initial registration, which
      // covers a first connection without an additional connection-ack read.
      if (!event?.initialConnection) invalidate();
    });
    disposeSubscription = () => {
      dispose();
      recover();
    };
  }
  return () => {
    listeners.delete(entry);
    if (!listeners.size) {
      disposeSubscription?.();
      disposeSubscription = null;
      clearIntegrationConfigurationCache();
    }
  };
}
