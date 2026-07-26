import "server-only";

import { getPrismaClient } from "@/data/prisma-client";

import type {
  GitHubAuthentication,
  GitHubRateLimitSnapshotView,
} from "./types";

export type GitHubRateLimitMetadata = {
  limit: number;
  remaining: number;
  used: number;
  resetAt: Date;
  resource: string;
};

function nonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseGitHubRateLimitHeaders(
  headers: Pick<Headers, "get">,
): GitHubRateLimitMetadata | null {
  const limit = nonNegativeInteger(headers.get("x-ratelimit-limit"));
  const remaining = nonNegativeInteger(headers.get("x-ratelimit-remaining"));
  const used = nonNegativeInteger(headers.get("x-ratelimit-used"));
  const reset = nonNegativeInteger(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource")?.trim() ?? "";
  if (
    limit === null ||
    remaining === null ||
    used === null ||
    reset === null ||
    !resource
  ) {
    return null;
  }
  const resetAt = new Date(reset * 1000);
  if (!Number.isFinite(resetAt.getTime())) return null;
  return { limit, remaining, used, resetAt, resource };
}

export async function observeGitHubRateLimit(
  authentication: GitHubAuthentication,
  response: Response,
): Promise<GitHubRateLimitMetadata | null> {
  const metadata = parseGitHubRateLimitHeaders(response.headers);
  if (!metadata) return null;
  try {
    const prisma = await getPrismaClient();
    const id = `${authentication}:${metadata.resource}`;
    const observedAt = new Date();
    await prisma.gitHubRateLimitSnapshot.upsert({
      where: {
        authentication_resource: {
          authentication,
          resource: metadata.resource,
        },
      },
      create: { id, authentication, observedAt, ...metadata },
      update: { observedAt, ...metadata },
    });
  } catch {
    // Rate-limit telemetry must never make the original GitHub request fail.
  }
  return metadata;
}

export async function listGitHubRateLimitSnapshots(): Promise<
  GitHubRateLimitSnapshotView[]
> {
  const prisma = await getPrismaClient();
  const snapshots = await prisma.gitHubRateLimitSnapshot.findMany({
    orderBy: [{ resource: "asc" }, { authentication: "asc" }],
  });
  return snapshots.map((snapshot) => ({
    authentication: snapshot.authentication as GitHubAuthentication,
    resource: snapshot.resource,
    limit: snapshot.limit,
    remaining: snapshot.remaining,
    used: snapshot.used,
    resetAt: snapshot.resetAt.toISOString(),
    observedAt: snapshot.observedAt.toISOString(),
  }));
}
