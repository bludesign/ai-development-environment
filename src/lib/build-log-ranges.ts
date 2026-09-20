export type BuildLogRange = {
  scope: string;
  scopeId: string;
  fromSequence: number;
  throughSequence: number;
};

/** Compress only received sequence numbers; never acknowledge a missing chunk. */
export function buildLogRanges(
  chunks: ReadonlyArray<{ scope: string; scopeId: string; sequence: number }>,
): BuildLogRange[] {
  const scopes = new Map<
    string,
    { scope: string; scopeId: string; sequences: Set<number> }
  >();
  for (const chunk of chunks) {
    const key = JSON.stringify([chunk.scope, chunk.scopeId]);
    const group = scopes.get(key) ?? {
      scope: chunk.scope,
      scopeId: chunk.scopeId,
      sequences: new Set<number>(),
    };
    group.sequences.add(chunk.sequence);
    scopes.set(key, group);
  }
  const ranges: BuildLogRange[] = [];
  for (const group of scopes.values()) {
    let range: BuildLogRange | undefined;
    for (const sequence of [...group.sequences].sort((a, b) => a - b)) {
      if (range && sequence === range.throughSequence + 1)
        range.throughSequence = sequence;
      else {
        range = {
          scope: group.scope,
          scopeId: group.scopeId,
          fromSequence: sequence,
          throughSequence: sequence,
        };
        ranges.push(range);
      }
    }
  }
  return ranges;
}
