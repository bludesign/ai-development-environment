import {
  asRecord,
  type ProviderImportedRun,
  type ProviderUsage,
} from "./provider.js";

export function opencodeModel(value: unknown): string | undefined {
  const model = asRecord(value);
  const id = model.modelID ?? model.id;
  return typeof model.providerID === "string" && typeof id === "string"
    ? `${model.providerID}/${id}`
    : undefined;
}

export function opencodeTimestamp(value: unknown): string | undefined {
  const date = typeof value === "number" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function tokenUsage(value: unknown, model: string): ProviderUsage {
  const tokens = asRecord(value);
  const cache = asRecord(tokens.cache);
  const count = (value: unknown) => Math.floor(amount(value) ?? 0);
  return {
    model,
    inputTokens: count(tokens.input),
    outputTokens: count(tokens.output),
    reasoningTokens: count(tokens.reasoning),
    cacheReadTokens: count(cache.read),
    cacheWriteTokens: count(cache.write),
    pricingSource: "opencode-history",
  };
}

const tokenFields = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

function textParts(parts: Record<string, unknown>[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Project native v2 content into the envelopes used by the activity renderer. */
function nativePart(value: unknown): Record<string, unknown> {
  const part = asRecord(value);
  if (part.type !== "tool") return part;
  const state = asRecord(part.state);
  const time = asRecord(part.time);
  const content = Array.isArray(state.content)
    ? state.content.map(asRecord)
    : [];
  return {
    ...part,
    tool: part.name,
    state: {
      ...state,
      output: textParts(content),
      metadata: state.structured,
      time: { start: time.ran ?? time.created, end: time.completed },
    },
  };
}

/** Read persisted snapshots, never live event subscriptions (which cannot replay). */
export function opencodeImportedHistory(
  sessionValue: unknown,
  messageValues: unknown[],
): Partial<ProviderImportedRun> {
  const session = asRecord(sessionValue);
  const messages = new Map<string, Record<string, unknown>>();
  for (const [index, value] of messageValues.entries()) {
    const message = asRecord(value);
    const info = asRecord(message.info ?? message);
    messages.set(String(info.id ?? index), message);
  }
  const ordered = [...messages.entries()].sort(([, left], [, right]) => {
    const leftInfo = asRecord(left.info ?? left);
    const rightInfo = asRecord(right.info ?? right);
    return (
      Number(asRecord(leftInfo.time).created ?? 0) -
      Number(asRecord(rightInfo.time).created ?? 0)
    );
  });
  const events: NonNullable<ProviderImportedRun["events"]> = [];
  const totals = new Map<string, ProviderUsage>();
  const unpricedModels = new Set<string>();
  let model: string | undefined;
  let effort: string | undefined;
  let prompt: string | undefined;
  let finalOutput: string | undefined;
  let status: string | undefined;
  let requestedModel: string | undefined;
  let requestedVariant: string | undefined;
  let agent: string | undefined;

  const addUsage = (usage: ProviderUsage) => {
    const total = totals.get(usage.model) ?? {
      model: usage.model,
      pricingSource: "opencode-history",
    };
    for (const field of tokenFields)
      total[field] = (total[field] ?? 0) + (usage[field] ?? 0);
    if (usage.estimatedCost === undefined) unpricedModels.add(usage.model);
    else total.estimatedCost = (total.estimatedCost ?? 0) + usage.estimatedCost;
    totals.set(usage.model, total);
  };
  const emit = (
    id: string,
    type: string,
    summary: string,
    properties: Record<string, unknown>,
    createdAt?: string,
    detailMarkdown?: string,
  ) => {
    events.push({
      id,
      sequence: events.length,
      type: type.toUpperCase().replaceAll(".", "_"),
      summary: (summary.trim() || type).slice(0, 2_000),
      detailMarkdown,
      createdAt,
      raw: { type, properties },
    });
  };

  for (const [id, message] of ordered) {
    const legacy = !!message.info;
    const original = asRecord(message.info ?? message);
    const role = original.role ?? original.type;
    const time = asRecord(original.time);
    const createdAt = opencodeTimestamp(
      time.created ?? asRecord(session.time).created,
    );
    const parts = legacy
      ? Array.isArray(message.parts)
        ? message.parts.map(asRecord)
        : []
      : Array.isArray(original.content)
        ? original.content.map(nativePart)
        : [];
    if (
      !legacy &&
      ["user", "synthetic", "system", "compaction"].includes(String(role))
    )
      parts.push({
        id: "text",
        type: "text",
        text: original.text ?? original.summary,
      });
    if (!legacy && role === "shell")
      parts.push({
        id: original.callID ?? "shell",
        type: "tool",
        tool: "bash",
        state: {
          input: { command: original.command },
          output: original.output,
          status: time.completed ? "completed" : "running",
          time: { start: time.created, end: time.completed },
        },
      });
    const info = {
      ...original,
      id,
      sessionID: session.id,
      role,
      modelID: original.modelID ?? asRecord(original.model).id,
    };
    // Content lives in part events; do not repeat a whole message in every row.
    delete (info as Record<string, unknown>).content;
    emit(
      `message:${id}`,
      "message.updated",
      `${String(role ?? "Message")} message`,
      { info },
      createdAt,
    );
    for (const [index, part] of parts.entries()) {
      const state = asRecord(part.state);
      const detail = typeof part.text === "string" ? part.text : undefined;
      const summary =
        detail ??
        (part.type === "tool"
          ? String(part.tool ?? "Tool")
          : String(part.type ?? "Message part"));
      emit(
        `${id}:part:${String(part.id ?? index)}`,
        "message.part.updated",
        summary,
        { part: { ...part, sessionID: session.id, messageID: id } },
        opencodeTimestamp(
          asRecord(state.time).start ?? asRecord(part.time).created,
        ) ?? createdAt,
        detail,
      );
    }
    if (role === "user" || role === "model-switched") {
      requestedModel = opencodeModel(original.model);
      requestedVariant =
        typeof asRecord(original.model).variant === "string"
          ? String(asRecord(original.model).variant)
          : undefined;
      if (role === "user" && !prompt) prompt = textParts(parts) || undefined;
    }
    if (role !== "assistant") continue;
    const actualModel =
      opencodeModel(original) ?? opencodeModel(original.model);
    if (actualModel) {
      model = actualModel;
      effort =
        typeof original.variant === "string"
          ? original.variant
          : typeof asRecord(original.model).variant === "string"
            ? String(asRecord(original.model).variant)
            : actualModel === requestedModel
              ? (requestedVariant ?? "auto")
              : "auto";
    }
    agent = typeof original.agent === "string" ? original.agent : agent;
    const error = asRecord(original.error);
    status = original.error
      ? error.name === "MessageAbortedError"
        ? "CANCELLED"
        : "FAILED"
      : "COMPLETED";
    const responseText = textParts(parts);
    if (
      responseText &&
      original.summary !== true &&
      !["tool-calls", "tool_calls"].includes(String(original.finish))
    )
      finalOutput = responseText;
    // Assistant totals and step-finish parts describe the same usage.
    const steps = parts.filter((part) => part.type === "step-finish");
    if (
      original.tokens ||
      steps.length ||
      amount(original.cost) !== undefined
    ) {
      const usage = tokenUsage(original.tokens, actualModel ?? "unknown");
      if (!original.tokens)
        for (const step of steps) {
          const stepUsage = tokenUsage(step.tokens, usage.model);
          for (const field of tokenFields)
            usage[field] = (usage[field] ?? 0) + (stepUsage[field] ?? 0);
        }
      usage.estimatedCost =
        amount(original.cost) ??
        (steps.length && steps.every((step) => amount(step.cost) !== undefined)
          ? steps.reduce((sum, step) => sum + amount(step.cost)!, 0)
          : undefined);
      addUsage(usage);
    }
  }
  // A projected/reverted history can omit older usage. Its model is unknown,
  // even when the remaining history happens to contain only one model.
  if (session.tokens) {
    const usage = tokenUsage(session.tokens, "unknown");
    for (const field of tokenFields)
      usage[field] = Math.max(
        0,
        (usage[field] ?? 0) -
          [...totals.values()].reduce((sum, row) => sum + (row[field] ?? 0), 0),
      );
    if (tokenFields.some((field) => usage[field])) addUsage(usage);
  }
  for (const model of unpricedModels) {
    const usage = totals.get(model);
    if (usage) delete usage.estimatedCost;
  }
  const estimatedCost = amount(session.cost);
  return {
    events,
    ...(totals.size || session.tokens ? { usage: [...totals.values()] } : {}),
    model: model ?? requestedModel ?? opencodeModel(session.model),
    effort:
      effort ??
      requestedVariant ??
      (typeof asRecord(session.model).variant === "string"
        ? String(asRecord(session.model).variant)
        : undefined),
    prompt,
    finalOutput,
    status,
    kind: (agent ?? session.agent) === "plan" ? "PLAN" : "SESSION",
    ...(estimatedCost !== undefined
      ? { estimatedCost, pricingSource: "opencode-history" }
      : {}),
  };
}
