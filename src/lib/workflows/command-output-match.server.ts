import "server-only";

import { RE2 } from "re2-wasm";

import { validateCommandOutputPattern } from "./command-output-match";

/** Compile the exact regex implementation used by command output monitors. */
export function compileCommandOutputPattern(pattern: string, global = false) {
  validateCommandOutputPattern(pattern);
  try {
    return new RE2(pattern, global ? "gu" : "u");
  } catch (error) {
    throw new Error(
      `Output pattern is not valid RE2 syntax: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
