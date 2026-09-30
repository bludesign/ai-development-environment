import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  asRecord,
  type ProviderImportedRun,
  type ProviderUsage,
} from "./provider.js";

type TranscriptRecord = { type?: string; payload?: unknown };
const tokenFields = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function tokens(value: unknown, model: string): ProviderUsage {
  const raw = asRecord(value);
  const cached = count(raw.cached_input_tokens);
  return {
    model,
    inputTokens: Math.max(0, count(raw.input_tokens) - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: count(raw.cache_write_input_tokens),
    outputTokens: count(raw.output_tokens),
    reasoningTokens: count(raw.reasoning_output_tokens),
    pricingSource: "codex-transcript",
  };
}

/** Prefer per-response usage within each turn, preserving older legacy turns. */
export function codexTranscriptMetadata(
  records: TranscriptRecord[],
): Pick<ProviderImportedRun, "model" | "effort" | "usage"> {
  let model: string | undefined;
  let effort: string | undefined;
  const turnModels = new Map<string, string>();
  const responseTurns = new Set<string>();
  let contextTurn = "unknown-turn";
  for (const record of records) {
    const context = asRecord(record.payload);
    if (record.type === "turn_context") {
      contextTurn = String(context.turn_id ?? "unknown-turn");
      if (typeof context.model === "string") model = context.model;
      if (typeof context.effort === "string") effort = context.effort;
      if (model) turnModels.set(contextTurn, model);
    }
    if (record.type === "token_usage_record" && context.usage)
      responseTurns.add(String(context.turn_id ?? contextTurn));
  }
  const totals = new Map<string, ProviderUsage>();
  const seenResponses = new Set<string>();
  let currentModel: string | undefined;
  let currentTurn = "unknown-turn";
  let previous: ProviderUsage = { model: "unknown" };
  const add = (usage: ProviderUsage) => {
    const total = totals.get(usage.model) ?? {
      model: usage.model,
      pricingSource: usage.pricingSource,
    };
    for (const field of tokenFields)
      total[field] = (total[field] ?? 0) + (usage[field] ?? 0);
    totals.set(usage.model, total);
  };
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type === "turn_context") {
      currentTurn = String(payload.turn_id ?? "unknown-turn");
      if (typeof payload.model === "string") currentModel = payload.model;
    }
    if (record.type === "token_usage_record") {
      const responseId =
        typeof payload.response_id === "string"
          ? payload.response_id
          : undefined;
      if (responseId && seenResponses.has(responseId)) continue;
      if (responseId) seenResponses.add(responseId);
      const responseModel =
        typeof payload.model === "string"
          ? payload.model
          : (turnModels.get(String(payload.turn_id)) ?? currentModel);
      if (responseModel && payload.usage)
        add(tokens(payload.usage, responseModel));
    } else if (record.type === "event_msg" && payload.type === "token_count") {
      const raw = asRecord(payload.info).total_token_usage;
      if (!raw) continue;
      const cumulative = tokens(raw, currentModel ?? "unknown");
      const delta: ProviderUsage = {
        model: cumulative.model,
        pricingSource: "codex-transcript",
      };
      for (const field of tokenFields)
        delta[field] = Math.max(
          0,
          (cumulative[field] ?? 0) - (previous[field] ?? 0),
        );
      previous = cumulative;
      if (!responseTurns.has(currentTurn)) add(delta);
    }
  }
  return {
    model,
    effort,
    ...(totals.size ? { usage: [...totals.values()] } : {}),
  };
}

export async function readCodexTranscriptMetadata(path: string) {
  const records: TranscriptRecord[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const record = JSON.parse(line) as TranscriptRecord;
        if (
          record.type === "turn_context" ||
          record.type === "token_usage_record" ||
          (record.type === "event_msg" &&
            asRecord(record.payload).type === "token_count")
        )
          records.push(record);
      } catch {
        // Active sessions may end with an incomplete JSONL record.
      }
    }
    return codexTranscriptMetadata(records);
  } finally {
    lines.close();
    stream.destroy();
  }
}

function timestamp(value: unknown): string | undefined {
  const date =
    typeof value === "number"
      ? new Date(value < 1_000_000_000_000 ? value * 1_000 : value)
      : typeof value === "string"
        ? new Date(value)
        : undefined;
  return date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
}

/** Reuse the live activity renderer's JSON-RPC envelopes for persisted items. */
export function codexImportedHistory(
  threadValue: unknown,
): Pick<ProviderImportedRun, "events" | "finalOutput" | "kind" | "status"> {
  const thread = asRecord(threadValue);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const events: NonNullable<ProviderImportedRun["events"]> = [];
  let finalOutput: string | undefined;
  let kind: "PLAN" | "SESSION" = "SESSION";
  let status: string | undefined;
  for (const value of turns) {
    const turn = asRecord(value);
    for (const itemValue of Array.isArray(turn.items) ? turn.items : []) {
      const item = asRecord(itemValue);
      if (item.type === "plan") kind = "PLAN";
      if (
        (item.type === "agentMessage" &&
          (item.phase === "final_answer" || item.phase == null)) ||
        item.type === "plan"
      ) {
        if (typeof item.text === "string") finalOutput = item.text;
      }
      const detail =
        typeof item.text === "string"
          ? item.text
          : typeof item.command === "string"
            ? item.command
            : undefined;
      const inProgress = [
        "inProgress",
        "in_progress",
        "running",
        "pending",
      ].includes(String(item.status));
      events.push({
        id: `${String(turn.id ?? turns.indexOf(value))}:${String(item.id ?? events.length)}`,
        sequence: events.length,
        type: inProgress ? "ITEM_STARTED" : "ITEM_COMPLETED",
        summary: (detail || String(item.type ?? "Codex item")).slice(0, 2_000),
        detailMarkdown: detail,
        createdAt: timestamp(
          item.createdAt ?? turn.startedAt ?? thread.createdAt,
        ),
        raw: {
          method: inProgress ? "item/started" : "item/completed",
          params: { threadId: thread.id, turnId: turn.id, item },
        },
      });
    }
    if (typeof turn.status === "string") {
      const inProgress = turn.status === "inProgress";
      status =
        turn.status === "failed"
          ? "FAILED"
          : turn.status === "interrupted"
            ? "CANCELLED"
            : undefined;
      const error = asRecord(turn.error);
      const detail =
        typeof error.message === "string"
          ? error.message
          : typeof turn.error === "string"
            ? turn.error
            : undefined;
      events.push({
        id: `${String(turn.id ?? turns.indexOf(value))}:status`,
        sequence: events.length,
        type: inProgress ? "TURN_STARTED" : "TURN_COMPLETED",
        summary: detail || `Turn ${turn.status}`,
        detailMarkdown: detail,
        createdAt: timestamp(
          turn.completedAt ??
            turn.startedAt ??
            thread.updatedAt ??
            thread.createdAt,
        ),
        raw: {
          method: inProgress ? "turn/started" : "turn/completed",
          params: {
            threadId: thread.id,
            turn: { ...turn, items: undefined, error: detail ?? turn.error },
          },
        },
      });
    }
  }
  return { events, finalOutput, kind, status };
}
