import type { PrismaClient } from "@/generated/prisma/client";

import type { AdoptableCredential, CredentialDriver } from "./driver";
import { withCredentialMutationLocks } from "./mutation-locks";
import { CREDENTIALS, type CredentialStoreIssue } from "./types";

// External backends keep the secret while the database keeps only its metadata, so a fresh
// install with an existing Vault has every secret and no rows describing them. Adoption
// rebuilds those rows, which lets every read path stay database-first.
//
// It also repoints rows left behind by an earlier backend. The configured backend is the
// only one this install reads, so once it is confirmed to hold the secret its copy is the
// one in use and the stale row must say so instead of demanding a re-entry.

const ADOPTION_CONCURRENCY = 4;

export type AdoptionResult = {
  adopted: number;
  repointed: number;
  skipped: number;
  issue: CredentialStoreIssue | null;
};

const NOTHING_ADOPTED: AdoptionResult = {
  adopted: 0,
  repointed: 0,
  skipped: 0,
  issue: null,
};

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

// The static descriptors cover every credential a fresh install can use on its own. They
// are always probed because a read-only Vault policy may withhold the `list` capability.
function staticCandidates(): string[] {
  return Object.values(CREDENTIALS).map((descriptor) => descriptor.id);
}

async function candidateIds(
  driver: CredentialDriver,
  recorded: Iterable<string>,
): Promise<string[]> {
  const candidates = new Set(staticCandidates());
  // Rows naming another backend are probed by ID even when they have no static descriptor,
  // so a dynamic credential such as an external MCP server's headers is repointed too.
  for (const id of recorded) candidates.add(id);
  if (driver.list) {
    try {
      for (const id of await driver.list()) candidates.add(id);
    } catch {
      // A policy granting only `read` is a supported configuration, so a denied listing
      // narrows adoption to the static descriptors rather than failing it.
    }
  }
  return [...candidates];
}

export async function adoptExternalCredentials(
  prisma: PrismaClient,
  driver: CredentialDriver,
): Promise<AdoptionResult> {
  const describe = driver.describe?.bind(driver);
  if (!describe) return NOTHING_ADOPTED;

  try {
    const rows = await prisma.credential.findMany({
      select: { id: true, storageType: true },
    });
    // A row already recorded under this backend needs nothing. Every other ID is probed:
    // one with no row at all is adopted, and one naming a backend this install no longer
    // reads is repointed once the configured backend proves it holds the secret.
    const settled = new Set<string>();
    const stale = new Set<string>();
    for (const row of rows) {
      (row.storageType === driver.storageType ? settled : stale).add(row.id);
    }
    const pending = (await candidateIds(driver, stale)).filter(
      (id) => !settled.has(id),
    );
    if (!pending.length) return NOTHING_ADOPTED;

    let skipped = 0;
    const described = await mapWithLimit(
      pending,
      ADOPTION_CONCURRENCY,
      async (id): Promise<AdoptableCredential | null> => {
        try {
          return await describe(id);
        } catch {
          // A foreign or malformed secret sharing the mount must never become a row.
          skipped += 1;
          return null;
        }
      },
    );
    const adoptable = described.filter(
      (entry): entry is AdoptableCredential => entry !== null,
    );
    if (!adoptable.length) {
      return { adopted: 0, repointed: 0, skipped, issue: null };
    }

    // A concurrent save of the same credential owns the row. Holding the mutation locks
    // makes this re-check authoritative, so adoption never resurrects a row that a failed
    // write just rolled back, and SQLite never sees a duplicate insert.
    const counts = await withCredentialMutationLocks(
      adoptable.map((entry) => entry.id),
      async () => {
        const claimed = new Map(
          (
            await prisma.credential.findMany({
              where: { id: { in: adoptable.map((entry) => entry.id) } },
              select: { id: true, storageType: true },
            })
          ).map((row) => [row.id, row.storageType]),
        );
        const missing = adoptable.filter((entry) => !claimed.has(entry.id));
        const outdated = adoptable.filter(
          (entry) =>
            claimed.has(entry.id) &&
            claimed.get(entry.id) !== driver.storageType,
        );
        if (missing.length) {
          await prisma.credential.createMany({
            data: missing.map((entry) => ({
              id: entry.id,
              kind: entry.kind,
              ownerId: entry.ownerId,
              storageType: driver.storageType,
              payload: null,
              encrypted: false,
            })),
          });
        }
        for (const entry of outdated) {
          // The backend's own metadata describes the secret now in use, and the payload
          // columns belonged to the abandoned database copy, so both are replaced.
          await prisma.credential.update({
            where: { id: entry.id },
            data: {
              kind: entry.kind,
              ownerId: entry.ownerId,
              storageType: driver.storageType,
              payload: null,
              encrypted: false,
              encryptionVersion: null,
              nonce: null,
              authTag: null,
              keyFingerprint: null,
            },
          });
        }
        return { adopted: missing.length, repointed: outdated.length };
      },
    );
    if (counts.repointed > 0) {
      console.log(
        `[credentials] Repointed ${counts.repointed} credential row(s) to ${driver.storageType}, which already holds those secrets.`,
      );
    }
    return { ...counts, skipped, issue: null };
  } catch (error) {
    // Adoption is a recovery convenience. It must never take down a boot that would
    // otherwise succeed, so the failure is reported through the store status instead.
    return {
      adopted: 0,
      repointed: 0,
      skipped: 0,
      issue: {
        code: "VAULT_ADOPTION_FAILED",
        message:
          error instanceof Error
            ? `Existing ${driver.storageType} credentials could not be adopted: ${error.message}`
            : `Existing ${driver.storageType} credentials could not be adopted`,
      },
    };
  }
}
