"use client";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "./control-plane-client";

export const GITHUB_CONFIGURATION_QUERY = `query GitHubPageConfiguration { githubSettings { tokenConfigured defaultJiraKeyRegex updatedAt } }`;
const cache = new Map<string, { provider: string; value: unknown }>();
const revisions = new Map<string, number>();
const listeners = new Set<{ provider: string | null; listener: () => void }>();
let disposeSubscription: (() => void) | null = null;

export function clearIntegrationConfigurationCache(provider?: string) {
  for (const [key, entry] of cache)
    if (!provider || entry.provider === provider) cache.delete(key);
  const providers = provider
    ? [provider]
    : ["github", "gitlab", "jira", "cacheServer"];
  for (const key of providers)
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
}

export async function readIntegrationConfiguration<T>(
  provider: string,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const key = JSON.stringify([provider, query]);
  for (;;) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    const existing = cache.get(key);
    if (existing) return existing.value as T;
    const revision = revisions.get(provider) ?? 0;
    const value = await controlPlaneRequest<T>(query, undefined, options);
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (revision !== (revisions.get(provider) ?? 0)) continue;
    cache.set(key, { provider, value });
    return value;
  }
}

export function subscribeIntegrationConfiguration(
  provider: string | null,
  listener: () => void,
): () => void {
  const entry = { provider, listener };
  listeners.add(entry);
  if (!disposeSubscription) {
    const invalidate = (changed?: string) => {
      clearIntegrationConfigurationCache(changed);
      for (const item of listeners)
        if (!changed || !item.provider || item.provider === changed)
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
