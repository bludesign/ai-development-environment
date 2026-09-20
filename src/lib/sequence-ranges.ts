/** Compress received sequences without assuming gaps have already arrived. */
export function sequenceRanges(sequences: Iterable<number>) {
  const ranges: Array<{ fromSequence: number; throughSequence: number }> = [];
  for (const sequence of [...new Set(sequences)].sort((a, b) => a - b)) {
    const previous = ranges.at(-1);
    if (previous && sequence === previous.throughSequence + 1)
      previous.throughSequence = sequence;
    else ranges.push({ fromSequence: sequence, throughSequence: sequence });
  }
  return ranges;
}
