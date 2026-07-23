// Reading a provider's untouched on-disk session transcript back off the agent
// host. Only tools that persist a single JSONL file per session are supported
// (Claude Code, Codex); OpenCode stores messages as separate blobs and has no
// single file to return.
export const RUN_SESSION_READ_JOB_KIND = "runs.session.read";

export const RUN_SESSION_FILE_PROVIDERS = ["CLAUDE", "CODEX"] as const;
export type RunSessionFileProvider =
  (typeof RUN_SESSION_FILE_PROVIDERS)[number];

// Session transcripts are bounded but can grow large; cap the payload we carry
// back over the control connection so a runaway file cannot exhaust memory.
export const MAX_RUN_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export type RunSessionReadPayload = {
  provider: RunSessionFileProvider;
  nativeId: string;
  folder: string;
};

export type RunSessionReadResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  filename: string;
  contentBase64: string;
};

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function isRunSessionFileProvider(
  value: string,
): value is RunSessionFileProvider {
  return (RUN_SESSION_FILE_PROVIDERS as readonly string[]).includes(value);
}

export function parseRunSessionReadPayload(
  value: unknown,
): RunSessionReadPayload {
  const payload = objectValue(value, "runs.session.read payload");
  const provider = stringValue(payload.provider, "provider");
  if (!isRunSessionFileProvider(provider)) {
    throw new Error(`Unsupported session file provider: ${provider}`);
  }
  const nativeId = stringValue(payload.nativeId, "nativeId");
  // A session id is an opaque token embedded in a filesystem path; reject any
  // value that could traverse out of the provider's session directory.
  if (/[/\\]/.test(nativeId) || nativeId.includes("..")) {
    throw new Error("nativeId contains invalid path characters");
  }
  return {
    provider,
    nativeId,
    folder: stringValue(payload.folder, "folder"),
  };
}
