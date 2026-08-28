import { inspect } from "node:util";

const sensitiveLogValue = new RegExp(
  String.raw`((?:"?(?:authorization|password|accessToken|refreshToken|idToken|sessionToken|clientSecret|secret|privateKey)"?)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\n}\]]+)`,
  "gi",
);

export function redactSensitiveAuthLogOutput(output: string): string {
  return output.replace(sensitiveLogValue, '$1"[REDACTED]"');
}

export function formatBetterAuthLogArguments(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  args: unknown[],
): string[] {
  return [
    `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${message}`,
    ...args.map((argument) =>
      typeof argument === "string"
        ? argument
        : inspect(argument, { depth: 6, breakLength: 120 }),
    ),
  ].map(redactSensitiveAuthLogOutput);
}

export function logBetterAuth(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  const output = formatBetterAuthLogArguments(level, message, args);
  if (level === "error") console.error(...output);
  else if (level === "warn") console.warn(...output);
  else console.log(...output);
}
