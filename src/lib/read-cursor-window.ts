/** Reconcile the visible window without dropping pages already loaded by the user. */
export async function readCursorWindow<
  T,
  P extends { items: T[]; nextCursor: string | null },
>(
  load: (after: string | null, first: number) => Promise<P>,
  wanted: number,
  pageLimit: number,
  key: (item: T) => string,
): Promise<P> {
  const target = Math.max(1, wanted);
  let page = await load(null, Math.min(target, pageLimit));
  const items: T[] = [];
  const keys = new Set<string>();
  const cursors = new Set<string>();
  for (;;) {
    for (const item of page.items) {
      if (keys.has(key(item))) continue;
      keys.add(key(item));
      items.push(item);
    }
    if (items.length >= target || !page.nextCursor) return { ...page, items };
    if (cursors.has(page.nextCursor))
      throw new Error("The server returned a repeated pagination cursor");
    cursors.add(page.nextCursor);
    page = await load(
      page.nextCursor,
      Math.min(target - items.length, pageLimit),
    );
  }
}
