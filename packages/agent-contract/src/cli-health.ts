export const CLI_HEALTH_JOB_KIND = "cli.health";
export const CLI_HEALTH_MAX_CHECKS = 27;
export const CLI_HEALTH_MAX_OUTPUT_BYTES = 32 * 1024;
export const CLI_HEALTH_CHECK_TIMEOUT_MS = 15_000;

export type CliHealthCheckDefinition = {
  id: string;
  name: string;
  command: string;
  builtIn: boolean;
};

export type CliHealthJobPayload = {
  checks: CliHealthCheckDefinition[];
};

export type CliHealthCheckResult = CliHealthCheckDefinition & {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  checkedAt: string;
  timedOut: boolean;
  launchError: string | null;
  outputTruncated: boolean;
};

export type CliHealthJobResult = {
  exitCode: number | null;
  signal: null;
  timedOut: boolean;
  cancelled: boolean;
  checks: CliHealthCheckResult[];
};

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function checkDefinition(
  value: unknown,
  index: number,
): CliHealthCheckDefinition {
  const name = `cli.health checks[${index}]`;
  const check = objectValue(value, name);
  const allowed = new Set(["id", "name", "command", "builtIn"]);
  const unexpected = Object.keys(check).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Unexpected ${name} field: ${unexpected}`);
  for (const field of ["id", "name", "command"] as const) {
    if (typeof check[field] !== "string" || check[field].length === 0) {
      throw new Error(`${name}.${field} must be a non-empty string`);
    }
  }
  if (typeof check.builtIn !== "boolean") {
    throw new Error(`${name}.builtIn must be a boolean`);
  }
  if ((check.id as string).length > 100)
    throw new Error(`${name}.id is too long`);
  if ((check.name as string).length > 100)
    throw new Error(`${name}.name is too long`);
  if (
    (check.command as string).length > 4_096 ||
    (check.command as string).includes("\0")
  ) {
    throw new Error(`${name}.command is invalid`);
  }
  return check as CliHealthCheckDefinition;
}

export function parseCliHealthJobPayload(value: unknown): CliHealthJobPayload {
  const payload = objectValue(value, "cli.health payload");
  const unexpected = Object.keys(payload).find((key) => key !== "checks");
  if (unexpected)
    throw new Error(`Unexpected cli.health payload field: ${unexpected}`);
  if (!Array.isArray(payload.checks)) {
    throw new Error("cli.health payload.checks must be an array");
  }
  if (payload.checks.length > CLI_HEALTH_MAX_CHECKS) {
    throw new Error(
      `cli.health supports at most ${CLI_HEALTH_MAX_CHECKS} checks`,
    );
  }
  const checks = payload.checks.map(checkDefinition);
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new Error("cli.health check identifiers must be unique");
  }
  return { checks };
}
