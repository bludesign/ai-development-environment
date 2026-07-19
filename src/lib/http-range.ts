export type ByteRange = { start: number; end: number };

/**
 * Parses a single byte range, as sent by the iOS install daemon when it resumes
 * a package download.
 *
 * Returns `null` when the header is absent, malformed, or asks for multiple
 * ranges — a server is always permitted to answer those with the full body —
 * and `"unsatisfiable"` when the range starts past the end of the resource.
 */
export function parseRangeHeader(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (size <= 0) return "unsatisfiable";

  // `bytes=-n` asks for the final n bytes.
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";

  if (!rawEnd) return { start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
