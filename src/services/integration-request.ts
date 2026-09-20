/** Keep integration fan-out bounded while preserving the caller's item order. */
export async function mapIntegrationRequests<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, Math.max(1, concurrency)) },
      async () => {
        while (!failed && next < items.length) {
          const index = next++;
          try {
            results[index] = await mapper(items[index], index);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      },
    ),
  );
  return results;
}
