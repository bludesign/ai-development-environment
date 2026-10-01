/** Shows a checkout relative to its agent's base, preserving paths outside it. */
export function displayedRepositoryPath(
  folder: string,
  baseRepoDirectory: string | null | undefined,
): string {
  if (!baseRepoDirectory) return folder;
  const windows =
    /^[A-Za-z]:[\\/]/.test(baseRepoDirectory) ||
    baseRepoDirectory.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  const normalize = (value: string) =>
    windows ? value.replaceAll("/", "\\") : value;
  const trimTrailingSeparators = (value: string) => {
    const root = windows ? /^[A-Za-z]:\\$/.test(value) : value === "/";
    return root ? value : value.replace(/[\\/]+$/, "");
  };
  const base = trimTrailingSeparators(normalize(baseRepoDirectory));
  const checkout = trimTrailingSeparators(normalize(folder));
  const comparableBase = windows ? base.toLocaleLowerCase() : base;
  const comparableCheckout = windows ? checkout.toLocaleLowerCase() : checkout;
  if (comparableCheckout === comparableBase) return ".";
  const prefix = base.endsWith(separator) ? base : `${base}${separator}`;
  const comparablePrefix = windows ? prefix.toLocaleLowerCase() : prefix;
  return comparableCheckout.startsWith(comparablePrefix)
    ? checkout.slice(prefix.length)
    : folder;
}
