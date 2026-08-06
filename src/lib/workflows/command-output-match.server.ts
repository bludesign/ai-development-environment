import "server-only";

import { compileRe2 } from "@/lib/re2.server";
import { validateCommandOutputPattern } from "./command-output-match";

// RE2's zero-width assertions depend only on a finite set of surrounding-text
// conditions (text/line boundaries and word/non-word transitions). Probe each
// representative context with sticky matching so patterns such as `\b`, which
// do not match the empty input but still return an empty match, are rejected
// before the global runtime scanner can encounter them.
const ZERO_WIDTH_PROBES = ["", "aa", "  ", "a a", "a\na", " a", "a "];

function assertPatternConsumesText(pattern: string): void {
  for (const input of ZERO_WIDTH_PROBES) {
    const regex = compileRe2(pattern, {
      flags: "y",
      label: "Output pattern",
    });
    for (let index = 0; index <= input.length; index += 1) {
      regex.lastIndex = index;
      const match = regex.exec(input);
      if (match?.index === index && match[0]?.length === 0) {
        throw new Error("Output pattern must consume at least one character");
      }
    }
  }
}

/** Compile the exact regex implementation used by command output monitors. */
export function compileCommandOutputPattern(pattern: string, global = false) {
  validateCommandOutputPattern(pattern);
  try {
    const regex = compileRe2(pattern, {
      flags: global ? "g" : "",
      label: "Output pattern",
    });
    assertPatternConsumesText(pattern);
    return regex;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Output pattern must consume at least one character"
    ) {
      throw error;
    }
    if (error instanceof Error) throw error;
    throw new Error(`Output pattern is not valid RE2 syntax: ${String(error)}`);
  }
}
