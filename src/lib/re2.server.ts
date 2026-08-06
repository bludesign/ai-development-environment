import "server-only";

import { RE2 } from "re2-wasm";

export const RE2_PATTERN_MAX_LENGTH = 1_024;

export type CompileRe2Options = {
  flags?: string;
  label?: string;
  maxLength?: number;
};

function unicodeFlags(flags: string): string {
  return flags.includes("u") ? flags : `${flags}u`;
}

/** Compile an externally supplied pattern with the app's bounded RE2 policy. */
export function compileRe2(
  pattern: string,
  {
    flags = "",
    label = "Regex pattern",
    maxLength = RE2_PATTERN_MAX_LENGTH,
  }: CompileRe2Options = {},
): RE2 {
  if (pattern.length > maxLength) {
    throw new Error(`${label} must not exceed ${maxLength} characters`);
  }
  try {
    return new RE2(pattern, unicodeFlags(flags));
  } catch (error) {
    throw new Error(
      `${label} is not valid RE2 syntax: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
