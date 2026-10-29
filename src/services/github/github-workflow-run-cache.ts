import "server-only";

import { createHash } from "node:crypto";

/** Shared raw list pages, never a claim that a repository's history is complete. */
export class GitHubWorkflowRunCache {
  private readonly entries = new Map<
    string,
    { data: unknown; expiresAt: number; fetchedAt: Date }
  >();
  private readonly flights = new Map<
    string,
    Promise<{ data: unknown; fetchedAt: Date }>
  >();

  async read<T>(
    token: string,
    url: string,
    fetcher: () => Promise<T>,
    force = false,
  ): Promise<{ data: T; cached: boolean; fetchedAt: Date }> {
    const key = `${createHash("sha256").update(token).digest("hex")}\0${url}`;
    if (!force) {
      const entry = this.entries.get(key);
      if (entry && entry.expiresAt > Date.now())
        return {
          data: entry.data as T,
          cached: true,
          fetchedAt: entry.fetchedAt,
        };
      const flight = this.flights.get(key);
      if (flight)
        return {
          ...((await flight) as { data: T; fetchedAt: Date }),
          cached: true,
        };
    }
    this.entries.delete(key);
    const fetchedAt = new Date(Date.now());
    const flight = fetcher().then((data) => ({ data, fetchedAt }));
    this.flights.set(key, flight);
    try {
      const { data } = await flight;
      if (this.flights.get(key) === flight) {
        for (const [oldKey, entry] of this.entries)
          if (entry.expiresAt <= Date.now()) this.entries.delete(oldKey);
        if (this.entries.size >= 500)
          this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, {
          data,
          expiresAt: Date.now() + 30_000,
          fetchedAt,
        });
      }
      return { data, cached: false, fetchedAt };
    } finally {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    }
  }

  invalidateRepository(nameWithOwner: string): void {
    const path = `/repos/${nameWithOwner.toLowerCase()}/actions/`;
    for (const entries of [this.entries, this.flights])
      for (const key of entries.keys()) {
        const url = key.slice(key.indexOf("\0") + 1);
        if (decodeURI(new URL(url).pathname).toLowerCase().startsWith(path))
          entries.delete(key);
      }
  }

  clear(): void {
    this.entries.clear();
    // Removing a flight also prevents it from repopulating an invalidated cache.
    this.flights.clear();
  }
}
