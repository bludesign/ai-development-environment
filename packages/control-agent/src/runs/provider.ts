import type { RunRecord } from "../graphql-client.js";

export type StagedAttachment = {
  id: string;
  filename: string;
  contentType: string;
  path: string;
};

export type ProviderEvent = {
  type: string;
  summary: string;
  detailMarkdown?: string;
  raw?: unknown;
  createdAt?: string;
};

export type ProviderQuestion = {
  id: string;
  header?: string;
  prompt: string;
  multiSelect?: boolean;
  allowCustom?: boolean;
  options?: Array<{ label: string; description?: string }>;
};

export type ProviderUsage = {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
  toolCallCount?: number;
  pricingSource?: string;
};

export type ProviderCatalog = {
  models: Array<{ id: string; label: string; efforts: string[] }>;
};

export type ProviderCapabilities = {
  webSearch: boolean;
  questions: boolean;
  import: boolean;
  pause: boolean;
  steering: boolean;
  resume: boolean;
  nativeDelete: boolean;
};

export type ProviderCallbacks = {
  onNativeId: (nativeId: string, providerVersion?: string) => Promise<void>;
  onEvent: (event: ProviderEvent) => Promise<void>;
  onQuestion: (
    nativeRequestId: string,
    questions: ProviderQuestion[],
  ) => Promise<void>;
  onUsage: (usage: ProviderUsage) => Promise<void>;
};

export type ProviderStartInput = {
  run: RunRecord;
  prompt: string;
  attachments: StagedAttachment[];
  resumeNativeId?: string;
  fork?: boolean;
};

export type ProviderCompletion = {
  status: "COMPLETED" | "PAUSED" | "CANCELLED" | "FAILED";
  finalOutput?: string;
  error?: string;
};

export interface ProviderHandle {
  readonly nativeId?: string;
  readonly completion: Promise<ProviderCompletion>;
  interrupt(reason: "PAUSED" | "CANCELLED"): Promise<void>;
  steer(prompt: string, attachments: StagedAttachment[]): Promise<void>;
  answer(nativeRequestId: string, answers: unknown): Promise<void>;
}

export type ProviderImportWorktree = {
  id: string;
  folder: string;
  branch: string | null;
};

export type ProviderImportedRun = {
  nativeId: string;
  worktreeId: string;
  kind?: "PLAN" | "SESSION";
  status?: string;
  archived?: boolean;
  model?: string;
  effort?: string;
  prompt?: string;
  finalOutput?: string;
  branch?: string;
  createdAt?: string;
  updatedAt?: string;
  rawMetadata?: unknown;
};

export interface ProviderAdapter {
  readonly key: RunRecord["provider"];
  readonly capabilities: ProviderCapabilities;
  catalog?(): Promise<ProviderCatalog>;
  start(
    input: ProviderStartInput,
    callbacks: ProviderCallbacks,
  ): Promise<ProviderHandle>;
  delete(nativeId: string, cwd: string): Promise<void>;
  discover(worktrees: ProviderImportWorktree[]): Promise<ProviderImportedRun[]>;
  close?(): Promise<void>;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function firstString(value: unknown): string | undefined {
  const keys = [
    "text",
    "result",
    "message",
    "summary",
    "content",
    "output",
  ] as const;
  const pending = [value];
  const visited = new WeakSet<object>();

  while (pending.length) {
    const candidate = pending.pop();
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (!candidate || typeof candidate !== "object") continue;
    if (visited.has(candidate)) continue;
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        pending.push(candidate[index]);
      }
      continue;
    }

    const record = asRecord(candidate);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      pending.push(record[keys[index]]);
    }
  }
  return undefined;
}

export function answerArrays(value: unknown): string[][] {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      Array.isArray(entry)
        ? entry.map(String)
        : typeof entry === "object" && entry
          ? Array.isArray((entry as Record<string, unknown>).answers)
            ? ((entry as Record<string, unknown>).answers as unknown[]).map(
                String,
              )
            : [String((entry as Record<string, unknown>).answer ?? "")]
          : [String(entry)],
    );
  }
  const record = asRecord(value);
  return Object.values(record).map((entry) =>
    Array.isArray(asRecord(entry).answers)
      ? (asRecord(entry).answers as unknown[]).map(String)
      : Array.isArray(entry)
        ? entry.map(String)
        : [String(entry ?? "")],
  );
}
