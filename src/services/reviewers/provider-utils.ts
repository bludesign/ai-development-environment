import { createHash } from "node:crypto";

import type { ReviewerPerson, ReviewerPoolDiscovery } from "./types";

export type ProviderUser = {
  id: string | number;
  login?: string;
  username?: string;
  name?: string | null;
  avatar_url?: string | null;
  avatarUrl?: string | null;
  html_url?: string | null;
  web_url?: string | null;
  webUrl?: string | null;
  state?: string;
  type?: string;
  bot?: boolean;
  email?: string | null;
  public_email?: string | null;
  permissions?: { push?: boolean; maintain?: boolean; admin?: boolean };
  access_level?: number;
};

export function providerPerson(user: ProviderUser): ReviewerPerson {
  return {
    id: String(user.id).replace(/^gid:\/\/gitlab\/User\//, ""),
    username: user.login ?? user.username ?? "",
    name: user.name || user.login || user.username || String(user.id),
    avatarUrl: user.avatar_url ?? user.avatarUrl ?? null,
    url: user.html_url ?? user.web_url ?? user.webUrl ?? null,
  };
}

export function eligibleHuman(user: ProviderUser): boolean {
  return (
    user.type !== "Bot" &&
    !user.bot &&
    (!user.state || user.state.toLowerCase() === "active")
  );
}

export function uniquePeople(people: ReviewerPerson[]): ReviewerPerson[] {
  return [
    ...new Map(people.map((person) => [person.id, person])).values(),
  ].sort((a, b) => a.username.localeCompare(b.username));
}

export function ownerPoolKey(identity: string, principals: string[]): string {
  const normalized = [...new Set(principals)].sort().join("\n");
  return `${identity}:owners:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function mergePool(
  pools: Map<string, ReviewerPoolDiscovery>,
  pool: ReviewerPoolDiscovery,
): void {
  const previous = pools.get(pool.key);
  pools.set(pool.key, {
    ...pool,
    candidates: uniquePeople([
      ...(previous?.candidates ?? []),
      ...pool.candidates,
    ]),
  });
}

export function statusIs(error: unknown, status: number): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    error.statusCode === status,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function paginated<T>(
  read: (page: number) => Promise<T[]>,
  pageSize = 100,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const next = await read(page);
    if (!Array.isArray(next))
      throw new Error("The provider returned an invalid reviewer list");
    items.push(...next);
    if (next.length < pageSize) return items;
  }
  throw new Error("The provider reviewer list exceeded the pagination limit");
}
