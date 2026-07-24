import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  MAX_RUN_SESSION_FILE_BYTES,
  parseRunSessionReadPayload,
  type RunSessionReadPayload,
} from "@ai-development-environment/agent-contract/runs";

import type { AgentJobHandler } from "./index.js";

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// Claude Code stores one JSONL per session under a per-workspace directory whose
// name is the encoded working directory. The session id is the bare filename, so
// scan the project directories for `<nativeId>.jsonl` rather than reproducing the
// exact (and version-dependent) directory-encoding scheme.
export async function findClaudeSessionFile(
  nativeId: string,
  home: string,
): Promise<string | null> {
  const projectsDir = join(home, ".claude", "projects");
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const target = `${nativeId}.jsonl`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, target);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

// Codex writes rollout transcripts to ~/.codex/sessions/YYYY/MM/DD/ with the
// thread id embedded in the filename (rollout-<timestamp>-<threadId>.jsonl).
export async function findCodexSessionFile(
  nativeId: string,
  home: string,
): Promise<string | null> {
  const sessionsDir = join(home, ".codex", "sessions");
  const suffix = `-${nativeId}.jsonl`;
  const walk = async (dir: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(path);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return path;
      }
    }
    return null;
  };
  return walk(sessionsDir);
}

async function locateSessionFile(
  payload: RunSessionReadPayload,
  home: string,
): Promise<string | null> {
  return payload.provider === "CLAUDE"
    ? findClaudeSessionFile(payload.nativeId, home)
    : findCodexSessionFile(payload.nativeId, home);
}

export const readRunSession: AgentJobHandler = async (payload) => {
  const input = parseRunSessionReadPayload(payload);
  const path = await locateSessionFile(input, homedir());
  if (!path) {
    throw new Error(
      `No ${input.provider === "CLAUDE" ? "Claude" : "Codex"} session file found for this run on this agent`,
    );
  }
  const { size } = await stat(path);
  if (size > MAX_RUN_SESSION_FILE_BYTES) {
    throw new Error(
      `Session file is too large to export (${size} bytes exceeds the ${MAX_RUN_SESSION_FILE_BYTES} byte limit)`,
    );
  }
  const contents = await readFile(path);
  return {
    ...successfulProcess,
    filename: path.split("/").at(-1) ?? `${input.nativeId}.jsonl`,
    contentBase64: contents.toString("base64"),
  };
};
