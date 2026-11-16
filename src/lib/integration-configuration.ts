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
          invalidate(changed === "ALL" ? undefined : changed);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const recover = onControlPlaneRecovery((event) => {
      // The subscription emits ALL after its initial registration, closing the
      // HTTP/subscribe gap without an additional connection-ack read.
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
