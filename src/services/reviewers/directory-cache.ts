import { createHash, randomUUID } from "node:crypto";
import { getPrismaClient } from "@/data/prisma-client";

export const REVIEWER_DIRECTORY_TTL_SECONDS = 86400;
const flights = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();
export async function clearReviewerDirectory(provider: string) {
  generations.set(provider, (generations.get(provider) ?? 0) + 1);
  const prisma = await getPrismaClient();
  await prisma.reviewerDirectorySnapshot.deleteMany({ where: { provider } });
}
export async function cachedReviewerDirectory<T>(input: {
  provider: string;
  scope: string;
  endpoint: string;
  force?: boolean;
  load: () => Promise<T>;
  onCache?: (stale: boolean) => void;
}): Promise<T> {
  const prisma = await getPrismaClient();
  const key = createHash("sha256")
    .update(JSON.stringify([input.provider, input.scope, input.endpoint]))
    .digest("hex");
  const generation = generations.get(input.provider) ?? 0;
  const cached = await prisma.reviewerDirectorySnapshot.findUnique({
    where: { key },
  });
  if (
    cached &&
    !input.force &&
    Date.now() - cached.fetchedAt.getTime() <
      REVIEWER_DIRECTORY_TTL_SECONDS * 1000
  ) {
    input.onCache?.(false);
    return JSON.parse(cached.responseJson) as T;
  }
  const flightKey = `${generation}:${key}`;
  let pending = flights.get(flightKey) as Promise<T> | undefined;
  if (!pending) {
    pending = (async () => {
      const data = await input.load();
      if (generation === (generations.get(input.provider) ?? 0))
        await prisma.reviewerDirectorySnapshot.upsert({
          where: { key },
          create: {
            id: randomUUID(),
            key,
            provider: input.provider,
            endpoint: input.endpoint,
            responseJson: JSON.stringify(data),
            fetchedAt: new Date(),
          },
          update: { responseJson: JSON.stringify(data), fetchedAt: new Date() },
        });
      return data;
    })();
    flights.set(flightKey, pending);
    const settled = () => {
      if (flights.get(flightKey) === pending) flights.delete(flightKey);
    };
    void pending.then(settled, settled);
  }
  try {
    return await pending;
  } catch (error) {
    // Only reuse data in this credential scope, and never mark a failed refresh fresh.
    if (!cached || generation !== (generations.get(input.provider) ?? 0))
      throw error;
    input.onCache?.(true);
    return JSON.parse(cached.responseJson) as T;
  }
}
