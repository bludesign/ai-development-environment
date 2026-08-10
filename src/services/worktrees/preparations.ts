import { createHash } from "node:crypto";
import { posix } from "node:path";

import type {
  WorktreePreparationDefinition,
  WorktreePreparationKind,
  WorktreePreparationState,
} from "@ai-development-environment/agent-contract/worktrees";

export const MAX_REPOSITORY_PREPARATIONS = 500;
export const MAX_PREPARATION_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PREPARATION_TOTAL_BYTES = 20 * 1024 * 1024;

export type SavePreparationInput = {
  id?: string | null;
  kind: WorktreePreparationKind;
  path: string;
  contentBase64?: string | null;
};

export type NormalizedPreparationInput = {
  id: string | null;
  kind: WorktreePreparationKind;
  path: string;
  contents: Buffer | null;
};

export function normalizePreparationPath(value: string): string {
  const path = value.trim();
  const parts = path.split("/");
  if (
    !path ||
    path === "." ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    /[\\\0\r\n*?[\]]/.test(path) ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.some((part) => part.toLowerCase() === ".git") ||
    posix.normalize(path) !== path
  ) {
    throw new Error(
      `${value || "Path"} must be an exact repository-relative file path`,
    );
  }
  return path;
}

export function decodePreparationContents(value: string): Buffer {
  const maximumEncodedLength = Math.ceil(MAX_PREPARATION_FILE_BYTES / 3) * 4;
  if (value.length > maximumEncodedLength) {
    throw new Error("Each preparation upload must be 10 MiB or smaller");
  }
  const contents = Buffer.from(value, "base64");
  if (contents.toString("base64") !== value) {
    throw new Error("Uploaded preparation contents are not valid base64");
  }
  if (contents.byteLength > MAX_PREPARATION_FILE_BYTES) {
    throw new Error("Each preparation upload must be 10 MiB or smaller");
  }
  return contents;
}

export function preparationContentSha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function preparationDefinitionHash(input: {
  kind: WorktreePreparationKind;
  path: string;
  contents: Uint8Array | null;
}): string {
  const hash = createHash("sha256");
  hash.update(input.kind);
  hash.update("\0");
  hash.update(input.path);
  hash.update("\0");
  if (input.contents) hash.update(input.contents);
  return hash.digest("hex");
}

export function preparationPayload(preparation: {
  id: string;
  kind: string;
  path: string;
  contents: Uint8Array | null;
  definitionHash: string;
}): WorktreePreparationDefinition {
  return {
    id: preparation.id,
    kind: preparation.kind as WorktreePreparationKind,
    path: preparation.path,
    contentBase64:
      preparation.kind === "WRITE" && preparation.contents
        ? Buffer.from(preparation.contents).toString("base64")
        : null,
    definitionHash: preparation.definitionHash,
  };
}

export function overallPreparationState(
  states: WorktreePreparationState[],
): WorktreePreparationState | "NOT_CONFIGURED" {
  if (states.length === 0) return "NOT_CONFIGURED";
  for (const state of [
    "ERROR",
    "DRIFTED",
    "SUSPENDED",
    "PENDING",
    "UNDONE",
    "UNKNOWN",
  ] as const) {
    if (states.includes(state)) return state;
  }
  return states.every((state) => state === "NOT_APPLICABLE")
    ? "NOT_APPLICABLE"
    : "APPLIED";
}
