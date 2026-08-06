export const COMMAND_OUTPUT_PATTERN_MAX_LENGTH = 1_024;
export const COMMAND_OUTPUT_MATCH_BUFFER_BYTES = 16 * 1024 * 1024;

export type CommandOutputMatchMode = "ONCE" | "EACH_MATCH";

export function commandOutputPattern(config: unknown): string | null {
  const value = (config as { outputPattern?: unknown } | null)?.outputPattern;
  return typeof value === "string" && value.length ? value : null;
}

export function commandOutputMatchMode(
  config: unknown,
): CommandOutputMatchMode {
  return (config as { outputMatchMode?: unknown } | null)?.outputMatchMode ===
    "EACH_MATCH"
    ? "EACH_MATCH"
    : "ONCE";
}

/** Client-safe validation; the server authoritatively compiles with RE2. */
export function validateCommandOutputPattern(pattern: string): void {
  if (!pattern.length) throw new Error("Output pattern cannot be empty");
  if (pattern.length > COMMAND_OUTPUT_PATTERN_MAX_LENGTH) {
    throw new Error(
      `Output pattern must not exceed ${COMMAND_OUTPUT_PATTERN_MAX_LENGTH} characters`,
    );
  }
  // Syntax and zero-width checks are authoritative on the server. Keeping this
  // client-safe helper structural avoids rejecting RE2-only syntax in editors.
}
