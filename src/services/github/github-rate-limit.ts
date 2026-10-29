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

const restPauses = new Map<GitHubAuthentication, GitHubRateLimitMetadata>();

export class GitHubRestRateLimitError extends Error {
  readonly statusCode = 403;

  constructor(readonly rateLimit: GitHubRateLimitMetadata) {
    super(
      `GitHub REST rate limit is exhausted until ${rateLimit.resetAt.toISOString()}`,
    );
    this.name = "GitHubRestRateLimitError";
  }
}

export function clearGitHubRestRateLimitPause(
  authentication: GitHubAuthentication,
): void {
  restPauses.delete(authentication);
}

/** REST callers share a pause per authentication; GraphQL has a separate quota. */
export async function assertGitHubRestRateLimitAvailable(
  authentication: GitHubAuthentication,
): Promise<void> {
  let exhausted = restPauses.get(authentication);
  if (exhausted && exhausted.resetAt.getTime() <= Date.now()) {
    restPauses.delete(authentication);
    exhausted = undefined;
  }
  if (!exhausted) {
    try {
      const prisma = await getPrismaClient();
      const snapshot = await prisma.gitHubRateLimitSnapshot.findUnique({
        where: {
          authentication_resource: { authentication, resource: "core" },
        },
        select: {
          limit: true,
          remaining: true,
          used: true,
          resetAt: true,
          resource: true,
        },
      });
      if (
        snapshot?.remaining === 0 &&
        snapshot.resetAt.getTime() > Date.now()
      ) {
        exhausted = snapshot;
        restPauses.set(authentication, snapshot);
      }
    } catch {
      // Unavailable telemetry must not prevent a request on its own.
    }
  }
  exhausted = restPauses.get(authentication) ?? exhausted;
  if (exhausted && exhausted.resetAt.getTime() > Date.now())
    throw new GitHubRestRateLimitError(exhausted);
}

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
  if (
    metadata.resource === "core" &&
    metadata.remaining === 0 &&
    metadata.resetAt.getTime() > Date.now()
  ) {
    // Remember exhaustion before awaiting telemetry writes. A slower response
    // from an earlier request must not reopen this window's quota.
    restPauses.set(authentication, metadata);
  }
  try {
    const prisma = await getPrismaClient();
    const id = `${authentication}:${metadata.resource}`;
    const observedAt = new Date();
    const pause = restPauses.get(authentication);
    const snapshot =
      metadata.resource === "core" &&
      pause?.resetAt.getTime() === metadata.resetAt.getTime()
        ? pause
        : metadata;
    await prisma.gitHubRateLimitSnapshot.upsert({
      where: {
        authentication_resource: {
          authentication,
          resource: metadata.resource,
        },
      },
      create: { id, authentication, observedAt, ...snapshot },
      update: { observedAt, ...snapshot },
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
