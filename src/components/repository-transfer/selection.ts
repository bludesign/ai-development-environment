/** An excluded parent excludes all descendants, without losing their choices. */
export function isTransferItemSelected(
  key: string,
  excludedKeys: readonly string[],
  parents: ReadonlyMap<string, string | null>,
): boolean {
  const excluded = new Set(excludedKeys);
  const visited = new Set<string>();
  let current: string | null | undefined = key;
  while (current) {
    if (excluded.has(current) || visited.has(current)) return false;
    visited.add(current);
    current = parents.get(current);
  }
  return true;
}

export function setTransferItemSelected(
  key: string,
  selected: boolean,
  excludedKeys: readonly string[],
): string[] {
  return selected
    ? excludedKeys.filter((value) => value !== key)
    : [...new Set([...excludedKeys, key])];
}

export function transferValueLabel(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
