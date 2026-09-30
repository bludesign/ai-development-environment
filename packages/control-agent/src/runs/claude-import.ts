import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  asRecord,
  type ProviderImportedRun,
  type ProviderUsage,
} from "./provider.js";

const tokenFields = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;
function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function count(value: unknown): number {
  return Math.floor(amount(value) ?? 0);
}
function textBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  return Array.isArray(content)
    ? content
        .map(asRecord)
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => String(block.text).trim())
        .filter(Boolean)
        .join("\n\n")
    : "";
}
function timestamp(value: unknown): string | undefined {
  const date =
    typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : undefined;
  return date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
}

/** Claude repeats a request's usage on multiple content blocks: count each message id once. */
export function claudeTranscriptMetadata(
  values: unknown[],
): Partial<ProviderImportedRun> {
  const records = values.map(asRecord);
  const requests = new Map<string, ProviderUsage>();
  let model: string | undefined;
  let effort: string | undefined;
  let lastAssistant = -1;
  let costIndex = -1;
  let costState: Record<string, unknown> | undefined;
  for (const [index, record] of records.entries()) {
    if (record.isSidechain === true) continue;
    if (
      record.type === "cost-state" &&
      Object.keys(asRecord(record.modelUsage)).length
    ) {
      costIndex = index;
      costState = record;
    }
    const message = asRecord(record.message);
    if (
      record.type !== "assistant" ||
      typeof message.model !== "string" ||
      message.model.startsWith("<")
    )
      continue;
    model = message.model;
    lastAssistant = index;
    const recordedEffort = record.perTurnEffort ?? record.effort;
    if (
      typeof recordedEffort === "string" ||
      typeof recordedEffort === "number"
    )
      effort = String(recordedEffort);
    if (!message.usage) continue;
    const usage = asRecord(message.usage);
    const key = `${model}:${String(message.id ?? record.uuid ?? index)}`;
    const previous = requests.get(key);
    const current: ProviderUsage = {
      model,
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      reasoningTokens: count(
        asRecord(usage.output_tokens_details).thinking_tokens,
      ),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
      pricingSource: "claude-transcript",
    };
    // Partial snapshots can precede or repeat the completed request totals.
    if (previous)
      for (const field of tokenFields)
        current[field] = Math.max(previous[field] ?? 0, current[field] ?? 0);
    requests.set(key, current);
  }
  if (costState && costIndex >= lastAssistant) {
    const usage = Object.entries(asRecord(costState.modelUsage)).map(
      ([model, value]) => {
        const item = asRecord(value);
        return {
          model,
          inputTokens: count(item.inputTokens),
          outputTokens: count(item.outputTokens),
          reasoningTokens: count(item.thinkingTokens),
          cacheReadTokens: count(item.cacheReadInputTokens),
          cacheWriteTokens: count(item.cacheCreationInputTokens),
          ...(costState!.hasUnknownModelCost !== true &&
          amount(item.costUSD) !== undefined
            ? { estimatedCost: amount(item.costUSD) }
            : {}),
          pricingSource: "claude-transcript",
        };
      },
    );
    return {
      model,
      effort,
      usage,
      ...(costState.hasUnknownModelCost !== true &&
      amount(costState.totalCostUSD) !== undefined
        ? {
            estimatedCost: amount(costState.totalCostUSD),
            pricingSource: "claude-transcript",
          }
        : {}),
    };
  }
  const totals = new Map<string, ProviderUsage>();
  for (const request of requests.values()) {
    const total = totals.get(request.model) ?? {
      model: request.model,
      pricingSource: "claude-transcript",
    };
    for (const field of tokenFields)
      total[field] = (total[field] ?? 0) + (request[field] ?? 0);
    totals.set(request.model, total);
  }
  return {
    model,
    effort,
    ...(totals.size ? { usage: [...totals.values()] } : {}),
  };
}

export async function readClaudeTranscript(path: string): Promise<unknown[]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const records: unknown[] = [];
  try {
    for await (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (
          ["user", "assistant", "system", "result", "cost-state"].includes(
            record.type,
          )
        )
          records.push(record);
      } catch {
        // A running session may have an incomplete trailing line.
      }
    }
    return records;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** SDK history supplies the current conversation chain; JSONL supplies additional metadata. */
export function claudeImportedHistory(
  messageValues: unknown[],
  transcriptValues: unknown[] = [],
): Partial<ProviderImportedRun> {
  const metadata = new Map<string, Record<string, unknown>>();
  for (const value of transcriptValues) {
    const record = asRecord(value);
    if (typeof record.uuid === "string") metadata.set(record.uuid, record);
  }
  const messages = new Map<string, Record<string, unknown>>();
  for (const [index, value] of messageValues.entries()) {
    const message = asRecord(value);
    const id = String(message.uuid ?? index);
    messages.set(id, { ...message, ...metadata.get(id) });
  }
  const events: NonNullable<ProviderImportedRun["events"]> = [];
  const replies = new Map<string, Map<string, string>>();
  let prompt: string | undefined;
  let finalReplyId: string | undefined;
  let kind: "PLAN" | "SESSION" = "SESSION";
  for (const [id, record] of messages) {
    const message = asRecord(record.message);
    if (record.permissionMode === "plan") kind = "PLAN";
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    if (record.type === "user" && record.isMeta !== true && !prompt)
      prompt = textBlocks(content) || undefined;
    if (record.type === "assistant") {
      const reply = textBlocks(content);
      if (reply) {
        const replyId = String(message.id ?? id);
        const parts = replies.get(replyId) ?? new Map<string, string>();
        parts.set(id, reply);
        replies.set(replyId, parts);
        finalReplyId = replyId;
      }
    }
    const blocks = content.length ? content.map(asRecord) : [undefined];
    for (const [index, block] of blocks.entries()) {
      const detail =
        block?.type === "text" && typeof block.text === "string"
          ? block.text
          : undefined;
      const summary =
        detail ||
        (block?.type === "tool_use"
          ? String(block.name ?? "Tool call")
          : block?.type === "tool_result"
            ? textBlocks(block.content) || "Tool result"
            : String(
                block?.type ??
                  record.subtype ??
                  record.type ??
                  "Claude message",
              ));
      events.push({
        id: `${id}:${String(block?.id ?? index)}`,
        sequence: events.length,
        type: String(record.type ?? "message").toUpperCase(),
        summary: (summary.trim() || "Claude message").slice(0, 2_000),
        detailMarkdown: detail,
        createdAt: timestamp(record.timestamp),
        raw: {
          ...record,
          ...(block ? { message: { ...message, content: [block] } } : {}),
        },
      });
    }
  }
  return {
    ...claudeTranscriptMetadata(
      transcriptValues.length ? transcriptValues : [...messages.values()],
    ),
    kind,
    prompt,
    events,
    finalOutput: finalReplyId
      ? [...replies.get(finalReplyId)!.values()].join("\n\n")
      : undefined,
  };
}
