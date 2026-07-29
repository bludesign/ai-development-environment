// External backends cannot participate in the Prisma transaction that owns their metadata.
// Queue overlapping IDs across every CredentialService instance until external writes, the
// metadata transaction, and any rollback have all completed.
const credentialMutationTails = new Map<string, Promise<void>>();

export async function withCredentialMutationLocks<T>(
  ids: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(ids)].sort();
  if (!keys.length) return operation();

  const predecessors = keys.flatMap((key) => {
    const predecessor = credentialMutationTails.get(key);
    return predecessor ? [predecessor] : [];
  });
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const key of keys) credentialMutationTails.set(key, tail);

  await Promise.all(predecessors);
  try {
    return await operation();
  } finally {
    release();
    for (const key of keys) {
      if (credentialMutationTails.get(key) === tail) {
        credentialMutationTails.delete(key);
      }
    }
  }
}
