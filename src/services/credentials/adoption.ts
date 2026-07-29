import type { PrismaClient } from "@/generated/prisma/client";

import type { AdoptableCredential, CredentialDriver } from "./driver";
import { withCredentialMutationLocks } from "./mutation-locks";
import { CREDENTIALS, type CredentialStoreIssue } from "./types";

// External backends keep the secret while the database keeps only its metadata, so a fresh
// install with an existing Vault has every secret and no rows describing them. Adoption
// rebuilds those rows, which lets every read path stay database-first.

const ADOPTION_CONCURRENCY = 4;

export type AdoptionResult = {
  adopted: number;
  skipped: number;
  issue: CredentialStoreIssue | null;
};

const NOTHING_ADOPTED: AdoptionResult = {
  adopted: 0,
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

async function candidateIds(driver: CredentialDriver): Promise<string[]> {
  const candidates = new Set(staticCandidates());
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
    const existing = new Set(
      (await prisma.credential.findMany({ select: { id: true } })).map(
        (row) => row.id,
      ),
    );
    // A row recorded under another backend keeps its BACKEND_MISMATCH warning. Silently
    // repointing it would swap the secret a feature has been using.
    const pending = (await candidateIds(driver)).filter(
      (id) => !existing.has(id),
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
    if (!adoptable.length) return { adopted: 0, skipped, issue: null };

    // A concurrent save of the same credential owns the row. Holding the mutation locks
    // makes this re-check authoritative, so adoption never resurrects a row that a failed
    // write just rolled back, and SQLite never sees a duplicate insert.
    const adopted = await withCredentialMutationLocks(
      adoptable.map((entry) => entry.id),
      async () => {
        const claimed = new Set(
          (
            await prisma.credential.findMany({
              where: { id: { in: adoptable.map((entry) => entry.id) } },
              select: { id: true },
            })
          ).map((row) => row.id),
        );
        const missing = adoptable.filter((entry) => !claimed.has(entry.id));
        if (!missing.length) return 0;
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
        return missing.length;
      },
    );
    return { adopted, skipped, issue: null };
  } catch (error) {
    // Adoption is a recovery convenience. It must never take down a boot that would
    // otherwise succeed, so the failure is reported through the store status instead.
    return {
      adopted: 0,
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
