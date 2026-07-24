import {
  Activity,
  AlertTriangle,
  Bot,
  Brain,
  CheckCircle2,
  CircleDot,
  CircleHelp,
  ClipboardList,
  FileDiff,
  Gauge,
  Globe,
  Info,
  ListChecks,
  MessageSquare,
  Play,
  Plug,
  Server,
  Settings2,
  Terminal,
  Unplug,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { formatEnumLabel } from "@/lib/enum-label";

import type { RunEventView } from "./types";

/**
 * The activity feed carries three shapes of event in one stream: the events the
 * control agent writes itself (SCREAMING_SNAKE types like `SYSTEM`), Codex
 * app-server JSON-RPC notifications (a `method`/`params` envelope in `raw`), and
 * OpenCode SDK events. This module turns each into a glanceable row — an icon, a
 * readable title, a one-line summary, and a set of parsed detail rows — without
 * the caller having to know which protocol produced it.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rawRecord(event: RunEventView): Record<string, unknown> {
  return asRecord(event.raw);
}

/** The Codex envelope is the only one that carries a JSON-RPC `method`. */
export function codexMethod(event: RunEventView): string | null {
  const method = rawRecord(event).method;
  return typeof method === "string" && method.length ? method : null;
}

function codexParams(event: RunEventView): Record<string, unknown> {
  return asRecord(rawRecord(event).params);
}

/** OpenCode SDK events carry a dotted event name and a `properties` payload. */
export function opencodeEventType(event: RunEventView): string | null {
  const raw = rawRecord(event);
  const type = text(raw.type);
  return type && raw.properties ? type : null;
}

function opencodeProperties(event: RunEventView): Record<string, unknown> {
  return asRecord(rawRecord(event).properties);
}

function claudeRecord(event: RunEventView): Record<string, unknown> | null {
  const raw = rawRecord(event);
  const type = text(raw.type);
  if (!type || opencodeEventType(event) || codexMethod(event)) return null;
  const hasClaudeEnvelope =
    raw.session_id !== undefined ||
    raw.uuid !== undefined ||
    raw.message !== undefined ||
    raw.subtype !== undefined;
  if (
    hasClaudeEnvelope &&
    ["system", "user", "assistant", "result"].includes(type)
  )
    return raw;
  return null;
}

/**
 * Renders a protocol identifier as a title: `mcpServer/startupStatus/updated`
 * becomes `Mcp Server Startup Status Updated`. Segments split on the delimiters
 * providers use (`/._-`) and on camel-case and letter/number boundaries, so a
 * name assembled from any of them reads as words.
 */
export function formatMethodTitle(method: string): string {
  return method
    .split(/[/._-]/)
    .flatMap((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])([0-9])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(" "),
    )
    .filter((word) => /[a-z0-9]/i.test(word))
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function shortId(value: unknown): string {
  const id = text(value);
  if (!id) return "";
  const tail = id.includes("-") ? id.split("-").pop()! : id;
  return tail.slice(0, 8);
}

function stripTrailingZero(value: string): string {
  return value.replace(/\.0$/, "");
}

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000)
    return `${stripTrailingZero((value / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${stripTrailingZero((value / 1_000).toFixed(1))}K`;
  return String(value);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${stripTrailingZero((ms / 1_000).toFixed(1))}s`;
  return `${stripTrailingZero((ms / 60_000).toFixed(1))}m`;
}

function formatCost(value: number): string {
  const digits = value > 0 && value < 0.01 ? 6 : 2;
  return `$${value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function linePreview(value: string, max = 180): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function formattedValue(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value) && value.length)
    return value
      .map((entry) => text(entry) ?? truncateJson(entry, 240))
      .filter(Boolean)
      .join(", ");
  const record = asRecord(value);
  return Object.keys(record).length ? truncateJson(record, 500) : null;
}

/** One line of parsed detail: a technical field name and its formatted value. */
export type ActivityDetailRow = { label: string; value: string };

export type ActivityDescriptor = {
  icon: LucideIcon;
  /**
   * A readable provider-aware event title; `null` for the agent's own events,
   * which carry a localized label the caller supplies.
   */
  methodTitle: string | null;
  /** A single glanceable summary line; empty when the caller should fall back. */
  line: string;
  detailRows: ActivityDetailRow[];
};

/**
 * `item/*` notifications describe a typed item (`reasoning`, `agentMessage`,
 * `commandExecution`, …). The item's type is the useful label and drives the
 * icon, so it is lifted out wherever a method carries one.
 */
function itemType(event: RunEventView): string | null {
  return text(asRecord(codexParams(event).item).type);
}

const ITEM_ICONS: Array<[RegExp, LucideIcon]> = [
  [/reason|think/i, Brain],
  [/command|exec|shell|bash|terminal/i, Terminal],
  [/file|patch|edit|diff|apply/i, FileDiff],
  [/websearch|web_search|search/i, Globe],
  [/todo|plan/i, ListChecks],
  [/mcp|tool/i, Wrench],
  [/message/i, MessageSquare],
  [/error|fail/i, AlertTriangle],
];

const METHOD_ICONS: Array<[RegExp, LucideIcon]> = [
  [/tokenusage/i, Gauge],
  [/mcpserver/i, Server],
  [/settings/i, Settings2],
  [/^turn\/started/i, Play],
  [/^turn\/completed/i, CheckCircle2],
  [/status/i, Activity],
  [/requestuserinput|question/i, CircleHelp],
  [/disconnect/i, Unplug],
  [/serverconnect|connected/i, Plug],
  [/plan/i, ClipboardList],
];

const TYPE_ICONS: Array<[RegExp, LucideIcon]> = [
  [/question/i, CircleHelp],
  [/command|terminal|exec|bash/i, Terminal],
  [/tool/i, Wrench],
  [/file|diff|patch|edit/i, FileDiff],
  [/reason|think/i, Brain],
  [/usage|token|cost/i, Gauge],
  [/status/i, Activity],
  [/web|search/i, Globe],
  [/plan/i, ClipboardList],
  [/result|complete|success|finish/i, CheckCircle2],
  [/user/i, MessageSquare],
  [/assistant|agent|message|text/i, Bot],
  [/error|fail/i, AlertTriangle],
  [/system|init|hook/i, Info],
];

function pickIcon(
  table: Array<[RegExp, LucideIcon]>,
  value: string,
): LucideIcon | null {
  for (const [pattern, icon] of table) if (pattern.test(value)) return icon;
  return null;
}

function activityIcon(event: RunEventView): LucideIcon {
  const method = codexMethod(event);
  if (method) {
    const type = itemType(event);
    if (type) return pickIcon(ITEM_ICONS, type) ?? CircleDot;
    return pickIcon(METHOD_ICONS, method) ?? Bot;
  }

  const openType = opencodeEventType(event);
  if (openType) {
    const properties = opencodeProperties(event);
    if (openType === "message.part.updated") {
      const part = asRecord(properties.part);
      const partType = text(part.type) ?? "";
      if (partType === "tool") {
        const tool = text(part.tool) ?? "";
        return (
          pickIcon(ITEM_ICONS, tool) ?? pickIcon(TYPE_ICONS, tool) ?? Wrench
        );
      }
      return pickIcon(TYPE_ICONS, partType) ?? CircleDot;
    }
    if (openType === "message.updated") {
      const role = text(asRecord(properties.info).role) ?? "message";
      return role === "user" ? MessageSquare : Bot;
    }
    return pickIcon(TYPE_ICONS, openType) ?? Bot;
  }

  const claude = claudeRecord(event);
  if (claude) {
    const type = text(claude.type) ?? event.type;
    const subtype = text(claude.subtype) ?? "";
    if (type === "result")
      return claude.is_error === true ? AlertTriangle : CheckCircle2;
    if (
      type === "user" &&
      asRecord(claude.tool_use_result).stdout !== undefined
    )
      return Terminal;
    if (type === "system" && subtype === "init") return Settings2;
    if (type === "system" && subtype === "hook_response")
      return claude.outcome === "success" ? CheckCircle2 : AlertTriangle;
    return pickIcon(TYPE_ICONS, `${type} ${subtype}`) ?? Bot;
  }
  return pickIcon(TYPE_ICONS, event.type) ?? Bot;
}

/**
 * A one-line, non-localized digest of a Codex `item` — the message text, the
 * command, or, failing anything printable, the item's type as words.
 */
function itemLine(item: Record<string, unknown>): string {
  const value =
    text(item.text) ??
    text(item.command) ??
    text(item.message) ??
    firstArrayText(item.summary) ??
    firstArrayText(item.content);
  if (value) return value.replace(/\s+/g, " ").trim();
  const type = text(item.type);
  return type ? formatMethodTitle(type) : "";
}

function firstArrayText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const direct = text(entry);
    if (direct) return direct;
    const record = asRecord(entry);
    const nested = text(record.text) ?? text(record.content);
    if (nested) return nested;
  }
  return null;
}

/** A compact single-line JSON rendering for events without a parsed shape. */
export function truncateJson(value: unknown, max = 160): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    json = String(value);
  }
  json = json.replace(/\s+/g, " ").trim();
  if (json === "{}" || json === "null" || json === "") return "";
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

function primitiveRows(
  record: Record<string, unknown>,
  skip: Set<string> = new Set(),
): ActivityDetailRow[] {
  const rows: ActivityDetailRow[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key)) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) rows.push({ label: formatMethodTitle(key), value: trimmed });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      rows.push({ label: formatMethodTitle(key), value: String(value) });
    } else if (typeof value === "boolean") {
      rows.push({ label: formatMethodTitle(key), value: value ? "Yes" : "No" });
    }
  }
  return rows;
}

/**
 * Parses a Codex notification into a summary line and detail rows. Returns
 * `null` for methods with no parsed shape, so the caller falls back to a
 * truncated `params` rendering.
 */
function describeCodex(
  method: string,
  params: Record<string, unknown>,
  number: (value: number) => string,
): { line: string; detailRows: ActivityDetailRow[] } | null {
  if (/tokenusage/i.test(method)) {
    const usage = asRecord(params.tokenUsage ?? params.usage);
    const total = asRecord(usage.total ?? usage);
    const input = finiteNumber(total.inputTokens) ?? 0;
    const output = finiteNumber(total.outputTokens) ?? 0;
    const totalTokens = finiteNumber(total.totalTokens) ?? input + output;
    const cached = finiteNumber(total.cachedInputTokens);
    const reasoning = finiteNumber(total.reasoningOutputTokens);
    const context = finiteNumber(usage.modelContextWindow);
    const parts = [
      `↑${number(input)}`,
      `↓${number(output)}`,
      number(totalTokens),
    ];
    if (context) parts.push(`${compact(context)} ctx`);
    const detailRows: ActivityDetailRow[] = [
      { label: "Total", value: number(totalTokens) },
      { label: "Input", value: number(input) },
      { label: "Output", value: number(output) },
    ];
    if (cached !== null)
      detailRows.push({ label: "Cached", value: number(cached) });
    if (reasoning !== null)
      detailRows.push({ label: "Reasoning", value: number(reasoning) });
    if (context !== null)
      detailRows.push({ label: "Context window", value: number(context) });
    return { line: parts.join(" · "), detailRows };
  }

  if (/^thread\/status/i.test(method)) {
    const status = asRecord(params.status);
    const type = text(status.type) ?? "";
    const flags = Array.isArray(status.activeFlags)
      ? status.activeFlags.map((flag) => formatMethodTitle(String(flag)))
      : [];
    const line = [formatMethodTitle(type), ...flags]
      .filter(Boolean)
      .join(" · ");
    const detailRows: ActivityDetailRow[] = type
      ? [{ label: "Status", value: formatMethodTitle(type) }]
      : [];
    if (flags.length)
      detailRows.push({ label: "Flags", value: flags.join(", ") });
    return { line, detailRows };
  }

  if (/^turn\//i.test(method)) {
    const turn = asRecord(params.turn);
    const status = text(turn.status);
    const duration = finiteNumber(turn.durationMs);
    const parts = [shortId(turn.id)];
    if (status) parts.push(formatMethodTitle(status));
    if (duration) parts.push(formatDuration(duration));
    const detailRows: ActivityDetailRow[] = [];
    if (turn.id) detailRows.push({ label: "Turn", value: shortId(turn.id) });
    if (status)
      detailRows.push({ label: "Status", value: formatMethodTitle(status) });
    if (duration !== null)
      detailRows.push({ label: "Duration", value: formatDuration(duration) });
    if (text(turn.error))
      detailRows.push({ label: "Error", value: text(turn.error)! });
    return { line: parts.filter(Boolean).join(" · "), detailRows };
  }

  if (/settings/i.test(method)) {
    const settings = asRecord(params.threadSettings ?? params.settings);
    const sandbox = asRecord(settings.sandboxPolicy);
    const collaboration = asRecord(settings.collaborationMode);
    const model = text(settings.model);
    const effort = text(settings.effort);
    const mode = text(collaboration.mode);
    const line = [model, effort, mode].filter(Boolean).join(" · ");
    const detailRows: ActivityDetailRow[] = [];
    if (model) detailRows.push({ label: "Model", value: model });
    if (text(settings.modelProvider))
      detailRows.push({
        label: "Provider",
        value: text(settings.modelProvider)!,
      });
    if (effort)
      detailRows.push({ label: "Effort", value: formatMethodTitle(effort) });
    if (mode)
      detailRows.push({ label: "Mode", value: formatMethodTitle(mode) });
    if (text(settings.approvalPolicy))
      detailRows.push({
        label: "Approval",
        value: formatMethodTitle(text(settings.approvalPolicy)!),
      });
    if (text(sandbox.type))
      detailRows.push({
        label: "Sandbox",
        value: formatMethodTitle(text(sandbox.type)!),
      });
    if (typeof sandbox.networkAccess === "boolean")
      detailRows.push({
        label: "Network access",
        value: sandbox.networkAccess ? "Yes" : "No",
      });
    if (text(settings.personality))
      detailRows.push({
        label: "Personality",
        value: formatMethodTitle(text(settings.personality)!),
      });
    if (text(settings.cwd))
      detailRows.push({
        label: "Working directory",
        value: text(settings.cwd)!,
      });
    return { line, detailRows };
  }

  if (/mcpserver/i.test(method)) {
    const name = text(params.name) ?? "";
    const status = text(params.status) ?? "";
    const failure = text(params.failureReason) ?? text(params.error);
    const line = [name, formatMethodTitle(status), failure]
      .filter(Boolean)
      .join(" · ");
    const detailRows: ActivityDetailRow[] = [];
    if (name) detailRows.push({ label: "Server", value: name });
    if (status)
      detailRows.push({ label: "Status", value: formatMethodTitle(status) });
    if (failure) detailRows.push({ label: "Failure", value: failure });
    return { line, detailRows };
  }

  if (/\/delta$/i.test(method)) {
    const delta = text(params.delta) ?? "";
    return { line: delta.replace(/\s+/g, " ").trim(), detailRows: [] };
  }

  if (method.startsWith("item/") && params.item) {
    const item = asRecord(params.item);
    const detailRows = primitiveRows(item, new Set(["id"]));
    return { line: itemLine(item), detailRows };
  }

  if (/disconnect/i.test(method)) {
    const message = text(params.message) ?? "";
    return {
      line: message,
      detailRows: message ? [{ label: "Message", value: message }] : [],
    };
  }

  return null;
}

function pushTokenRows(
  rows: ActivityDetailRow[],
  tokens: Record<string, unknown>,
  number: (value: number) => string,
) {
  const values: Array<[string, unknown]> = [
    ["Total tokens", tokens.total ?? tokens.total_tokens],
    ["Input tokens", tokens.input ?? tokens.input_tokens],
    ["Output tokens", tokens.output ?? tokens.output_tokens],
    ["Reasoning tokens", tokens.reasoning ?? tokens.reasoning_tokens],
    [
      "Cache read tokens",
      asRecord(tokens.cache).read ?? tokens.cache_read_input_tokens,
    ],
    [
      "Cache write tokens",
      asRecord(tokens.cache).write ?? tokens.cache_creation_input_tokens,
    ],
  ];
  for (const [label, value] of values) {
    const count = finiteNumber(value);
    if (count !== null) rows.push({ label, value: number(count) });
  }
}

function describeOpenCode(
  event: RunEventView,
  eventType: string,
  number: (value: number) => string,
): Omit<ActivityDescriptor, "icon"> {
  const properties = opencodeProperties(event);

  if (eventType === "session.status") {
    const status = text(asRecord(properties.status).type) ?? "Unknown";
    return {
      methodTitle: "Session Status",
      line: formatMethodTitle(status),
      detailRows: [{ label: "Status", value: formatMethodTitle(status) }],
    };
  }

  if (eventType === "session.diff") {
    const diff = Array.isArray(properties.diff) ? properties.diff : [];
    let additions = 0;
    let deletions = 0;
    const detailRows: ActivityDetailRow[] = [];
    for (const [index, entry] of diff.entries()) {
      const file = asRecord(entry);
      additions += finiteNumber(file.additions) ?? 0;
      deletions += finiteNumber(file.deletions) ?? 0;
      const name = text(file.file) ?? text(file.path) ?? `File ${index + 1}`;
      const changes = [
        finiteNumber(file.additions) !== null
          ? `+${number(finiteNumber(file.additions)!)}`
          : null,
        finiteNumber(file.deletions) !== null
          ? `-${number(finiteNumber(file.deletions)!)}`
          : null,
        text(file.status) ? formatMethodTitle(text(file.status)!) : null,
      ]
        .filter(Boolean)
        .join(" · ");
      detailRows.push({ label: name, value: changes || "Changed" });
    }
    const line = diff.length
      ? `${number(diff.length)} ${diff.length === 1 ? "file" : "files"} · +${number(additions)} -${number(deletions)}`
      : "No file changes";
    return { methodTitle: "Session Diff", line, detailRows };
  }

  if (eventType === "session.updated") {
    const info = asRecord(properties.info);
    const model = asRecord(info.model);
    const tokens = asRecord(info.tokens);
    const title = text(info.title);
    const modelName = text(model.id);
    const agent = text(info.agent);
    const cost = finiteNumber(info.cost);
    const detailRows: ActivityDetailRow[] = [];
    if (title) detailRows.push({ label: "Title", value: title });
    if (text(info.slug))
      detailRows.push({ label: "Slug", value: text(info.slug)! });
    if (modelName) detailRows.push({ label: "Model", value: modelName });
    if (text(model.providerID))
      detailRows.push({ label: "Provider", value: text(model.providerID)! });
    if (text(model.variant))
      detailRows.push({ label: "Variant", value: text(model.variant)! });
    if (agent) detailRows.push({ label: "Agent", value: agent });
    if (text(info.version))
      detailRows.push({
        label: "OpenCode version",
        value: text(info.version)!,
      });
    if (text(info.directory))
      detailRows.push({
        label: "Working directory",
        value: text(info.directory)!,
      });
    pushTokenRows(detailRows, tokens, number);
    if (cost !== null)
      detailRows.push({ label: "Reported cost", value: formatCost(cost) });
    return {
      methodTitle: "Session Updated",
      line: [title, modelName, agent, cost ? formatCost(cost) : null]
        .filter(Boolean)
        .join(" · "),
      detailRows,
    };
  }

  if (eventType === "message.updated") {
    const info = asRecord(properties.info);
    const role = text(info.role) ?? "message";
    const modelRecord = asRecord(info.model);
    const model = text(info.modelID) ?? text(modelRecord.modelID);
    const provider = text(info.providerID) ?? text(modelRecord.providerID);
    const finish = text(info.finish);
    const agent = text(info.agent);
    const tokens = asRecord(info.tokens);
    const total = finiteNumber(tokens.total);
    const cost = finiteNumber(info.cost);
    const detailRows: ActivityDetailRow[] = [
      { label: "Role", value: formatMethodTitle(role) },
    ];
    if (model) detailRows.push({ label: "Model", value: model });
    if (provider) detailRows.push({ label: "Provider", value: provider });
    if (agent) detailRows.push({ label: "Agent", value: agent });
    if (text(info.mode))
      detailRows.push({
        label: "Mode",
        value: formatMethodTitle(text(info.mode)!),
      });
    if (finish)
      detailRows.push({
        label: "Finish reason",
        value: formatMethodTitle(finish),
      });
    pushTokenRows(detailRows, tokens, number);
    if (cost !== null)
      detailRows.push({ label: "Reported cost", value: formatCost(cost) });
    return {
      methodTitle: `${formatMethodTitle(role)} Message`,
      line: [
        model,
        agent,
        finish ? formatMethodTitle(finish) : "Started",
        total !== null && total > 0 ? `${number(total)} tokens` : null,
        cost ? formatCost(cost) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      detailRows,
    };
  }

  if (eventType === "message.part.delta") {
    const delta = text(properties.delta) ?? "";
    const field = text(properties.field);
    const detailRows: ActivityDetailRow[] = [];
    if (field)
      detailRows.push({ label: "Field", value: formatMethodTitle(field) });
    if (delta) detailRows.push({ label: "Text", value: delta });
    return {
      methodTitle: "Message Text Delta",
      line: linePreview(delta),
      detailRows,
    };
  }

  if (eventType === "message.part.updated") {
    const part = asRecord(properties.part);
    const partType = text(part.type) ?? "part";
    if (partType === "tool") {
      const tool = text(part.tool) ?? "Tool";
      const state = asRecord(part.state);
      const input = asRecord(state.input);
      const metadata = asRecord(state.metadata);
      const time = asRecord(state.time);
      const status = text(state.status);
      const command = text(input.command);
      const title = text(state.title) ?? command;
      const start = finiteNumber(time.start);
      const end = finiteNumber(time.end);
      const duration = start !== null && end !== null ? end - start : null;
      const exit = finiteNumber(metadata.exit);
      const output = text(state.output) ?? text(metadata.output);
      const detailRows: ActivityDetailRow[] = [
        { label: "Tool", value: formatMethodTitle(tool) },
      ];
      if (status)
        detailRows.push({ label: "Status", value: formatMethodTitle(status) });
      if (title) detailRows.push({ label: "Title", value: title });
      if (command && command !== title)
        detailRows.push({ label: "Command", value: command });
      if (duration !== null)
        detailRows.push({ label: "Duration", value: formatDuration(duration) });
      if (exit !== null)
        detailRows.push({ label: "Exit code", value: number(exit) });
      const inputValue = formattedValue(input);
      if (inputValue && !command)
        detailRows.push({ label: "Input", value: inputValue });
      if (output) detailRows.push({ label: "Output", value: output });
      return {
        methodTitle: `${formatMethodTitle(tool)} Tool`,
        line: [
          title ?? formatMethodTitle(tool),
          status ? formatMethodTitle(status) : null,
          duration !== null ? formatDuration(duration) : null,
          exit !== null ? `exit ${number(exit)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        detailRows,
      };
    }

    if (partType === "step-start") {
      const snapshot = shortId(part.snapshot);
      return {
        methodTitle: "Step Started",
        line: snapshot ? `Snapshot ${snapshot}` : "Started",
        detailRows: snapshot
          ? [{ label: "Snapshot", value: text(part.snapshot)! }]
          : [],
      };
    }

    if (partType === "step-finish") {
      const reason = text(part.reason);
      const tokens = asRecord(part.tokens);
      const input = finiteNumber(tokens.input);
      const output = finiteNumber(tokens.output);
      const reasoning = finiteNumber(tokens.reasoning);
      const cost = finiteNumber(part.cost);
      const detailRows: ActivityDetailRow[] = [];
      if (reason)
        detailRows.push({
          label: "Finish reason",
          value: formatMethodTitle(reason),
        });
      pushTokenRows(detailRows, tokens, number);
      if (cost !== null)
        detailRows.push({ label: "Reported cost", value: formatCost(cost) });
      if (text(part.snapshot))
        detailRows.push({ label: "Snapshot", value: text(part.snapshot)! });
      return {
        methodTitle: "Step Finished",
        line: [
          reason ? formatMethodTitle(reason) : "Finished",
          input !== null ? `↑${number(input)}` : null,
          output !== null ? `↓${number(output)}` : null,
          reasoning ? `${number(reasoning)} reasoning` : null,
          cost ? formatCost(cost) : null,
        ]
          .filter(Boolean)
          .join(" · "),
        detailRows,
      };
    }

    return {
      methodTitle: formatMethodTitle(partType),
      line: formatMethodTitle(partType),
      detailRows: primitiveRows(
        part,
        new Set(["id", "messageID", "sessionID"]),
      ),
    };
  }

  return {
    methodTitle: formatMethodTitle(eventType),
    line: truncateJson(properties) || event.summary || "",
    detailRows: primitiveRows(properties),
  };
}

function claudeContent(
  raw: Record<string, unknown>,
): Record<string, unknown>[] {
  const content = asRecord(raw.message).content;
  return Array.isArray(content) ? content.map(asRecord) : [];
}

function describeClaude(
  event: RunEventView,
  raw: Record<string, unknown>,
  number: (value: number) => string,
): Omit<ActivityDescriptor, "icon"> {
  const type = text(raw.type) ?? event.type.toLowerCase();
  const subtype = text(raw.subtype);

  if (type === "system" && subtype === "init") {
    const servers = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
    const tools = Array.isArray(raw.tools) ? raw.tools : [];
    const agents = Array.isArray(raw.agents) ? raw.agents : [];
    const skills = Array.isArray(raw.skills) ? raw.skills : [];
    const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
    const model = text(raw.model);
    const version = text(raw.claude_code_version);
    const permission = text(raw.permissionMode);
    const detailRows: ActivityDetailRow[] = [];
    if (model) detailRows.push({ label: "Model", value: model });
    if (version)
      detailRows.push({ label: "Claude Code version", value: version });
    if (permission)
      detailRows.push({
        label: "Permission mode",
        value: formatMethodTitle(permission),
      });
    if (text(raw.cwd))
      detailRows.push({ label: "Working directory", value: text(raw.cwd)! });
    if (tools.length)
      detailRows.push({
        label: "Tools",
        value: `${number(tools.length)} available`,
      });
    if (agents.length)
      detailRows.push({
        label: "Agents",
        value: agents.map(String).join(", "),
      });
    if (skills.length)
      detailRows.push({
        label: "Skills",
        value: `${number(skills.length)} loaded`,
      });
    if (plugins.length)
      detailRows.push({
        label: "Plugins",
        value: `${number(plugins.length)} loaded`,
      });
    if (servers.length)
      detailRows.push({
        label: "MCP servers",
        value: servers
          .map((entry) => {
            const server = asRecord(entry);
            return [
              text(server.name),
              text(server.status) && formatMethodTitle(text(server.status)!),
            ]
              .filter(Boolean)
              .join(" · ");
          })
          .join(", "),
      });
    return {
      methodTitle: "Claude Initialization",
      line: [
        model,
        version ? `v${version}` : null,
        permission && formatMethodTitle(permission),
      ]
        .filter(Boolean)
        .join(" · "),
      detailRows,
    };
  }

  if (type === "system" && subtype?.startsWith("hook_")) {
    const hook = text(raw.hook_name) ?? text(raw.hook_event) ?? "Hook";
    const outcome = text(raw.outcome);
    const exit = finiteNumber(raw.exit_code);
    const phase =
      subtype === "hook_started"
        ? "Started"
        : outcome
          ? formatMethodTitle(outcome)
          : "Response";
    const detailRows: ActivityDetailRow[] = [
      { label: "Hook", value: hook },
      { label: "Status", value: phase },
    ];
    if (text(raw.hook_event))
      detailRows.push({
        label: "Event",
        value: formatMethodTitle(text(raw.hook_event)!),
      });
    if (exit !== null)
      detailRows.push({ label: "Exit code", value: number(exit) });
    if (text(raw.stdout))
      detailRows.push({ label: "Output", value: text(raw.stdout)! });
    if (text(raw.stderr))
      detailRows.push({ label: "Error output", value: text(raw.stderr)! });
    return {
      methodTitle:
        subtype === "hook_started" ? "Hook Started" : "Hook Response",
      line: [hook, phase, exit !== null ? `exit ${number(exit)}` : null]
        .filter(Boolean)
        .join(" · "),
      detailRows,
    };
  }

  if (type === "system" && subtype === "status") {
    const status = text(raw.status) ?? "Unknown";
    return {
      methodTitle: "Claude Status",
      line: formatMethodTitle(status),
      detailRows: [{ label: "Status", value: formatMethodTitle(status) }],
    };
  }

  if (type === "user") {
    const blocks = claudeContent(raw);
    const toolBlock = blocks.find(
      (block) => text(block.type) === "tool_result",
    );
    const result = asRecord(raw.tool_use_result);
    if (toolBlock || Object.keys(result).length) {
      const output =
        text(result.stdout) ?? text(toolBlock?.content) ?? event.summary;
      const error = text(result.stderr);
      const isError = toolBlock?.is_error === true || Boolean(error);
      const detailRows: ActivityDetailRow[] = [];
      if (text(toolBlock?.tool_use_id))
        detailRows.push({
          label: "Tool call",
          value: shortId(toolBlock?.tool_use_id),
        });
      detailRows.push({
        label: "Status",
        value: isError ? "Failed" : "Completed",
      });
      if (output) detailRows.push({ label: "Output", value: output });
      if (error) detailRows.push({ label: "Error output", value: error });
      if (typeof result.interrupted === "boolean")
        detailRows.push({
          label: "Interrupted",
          value: result.interrupted ? "Yes" : "No",
        });
      return {
        methodTitle: "Tool Result",
        line: linePreview(
          output || (isError ? "Tool failed" : "Tool completed"),
        ),
        detailRows,
      };
    }
  }

  if (type === "assistant") {
    const message = asRecord(raw.message);
    const blocks = claudeContent(raw);
    const tool = blocks.find((block) => text(block.type) === "tool_use");
    const body = blocks.find((block) => text(block.type) === "text");
    const usage = asRecord(message.usage);
    const detailRows: ActivityDetailRow[] = [];
    if (text(message.model))
      detailRows.push({ label: "Model", value: text(message.model)! });
    pushTokenRows(detailRows, usage, number);
    if (tool) {
      const name = text(tool.name) ?? "Tool";
      const input = formattedValue(tool.input);
      if (input) detailRows.push({ label: "Input", value: input });
      return {
        methodTitle: `${formatMethodTitle(name)} Tool Call`,
        line: [name, input].filter(Boolean).join(" · "),
        detailRows,
      };
    }
    const bodyText = text(body?.text) ?? event.summary;
    return {
      methodTitle: "Assistant Message",
      line: linePreview(bodyText),
      detailRows,
    };
  }

  if (type === "result") {
    const usage = asRecord(raw.usage);
    const duration = finiteNumber(raw.duration_ms);
    const apiDuration = finiteNumber(raw.duration_api_ms);
    const ttft = finiteNumber(raw.ttft_ms);
    const turns = finiteNumber(raw.num_turns);
    const cost = finiteNumber(raw.total_cost_usd);
    const status =
      raw.is_error === true
        ? "Failed"
        : formatMethodTitle(text(raw.subtype) ?? "Completed");
    const detailRows: ActivityDetailRow[] = [
      { label: "Status", value: status },
    ];
    if (duration !== null)
      detailRows.push({ label: "Duration", value: formatDuration(duration) });
    if (apiDuration !== null)
      detailRows.push({
        label: "API duration",
        value: formatDuration(apiDuration),
      });
    if (ttft !== null)
      detailRows.push({
        label: "Time to first token",
        value: formatDuration(ttft),
      });
    if (turns !== null)
      detailRows.push({ label: "Turns", value: number(turns) });
    if (text(raw.stop_reason))
      detailRows.push({
        label: "Stop reason",
        value: formatMethodTitle(text(raw.stop_reason)!),
      });
    pushTokenRows(detailRows, usage, number);
    if (cost !== null)
      detailRows.push({ label: "Reported cost", value: formatCost(cost) });
    return {
      methodTitle: "Result",
      line: [
        status,
        duration !== null ? formatDuration(duration) : null,
        turns !== null
          ? `${number(turns)} ${turns === 1 ? "turn" : "turns"}`
          : null,
        cost !== null ? formatCost(cost) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      detailRows,
    };
  }

  return {
    methodTitle: subtype ? formatMethodTitle(`Claude ${subtype}`) : null,
    line: linePreview(event.summary || truncateJson(raw)),
    detailRows: primitiveRows(raw, new Set(["uuid", "session_id"])),
  };
}

/** The full parsed descriptor for one activity event. */
export function describeActivity(
  event: RunEventView,
  locale?: string,
): ActivityDescriptor {
  const icon = activityIcon(event);
  const method = codexMethod(event);
  const formatter = new Intl.NumberFormat(locale ?? "en-US");
  const number = (value: number) => formatter.format(value);
  if (method) {
    const parsed = describeCodex(method, codexParams(event), number);
    const line =
      parsed?.line || truncateJson(codexParams(event)) || event.summary || "";
    return {
      icon,
      methodTitle: formatMethodTitle(method),
      line,
      detailRows: parsed?.detailRows ?? [],
    };
  }

  const openType = opencodeEventType(event);
  if (openType) {
    const parsed = describeOpenCode(event, openType, number);
    return { icon, ...parsed };
  }

  const claude = claudeRecord(event);
  if (claude) {
    const parsed = describeClaude(event, claude, number);
    return { icon, ...parsed };
  }

  return {
    icon,
    methodTitle: null,
    line: event.summary ?? "",
    detailRows: [],
  };
}

/**
 * The title for a grouped item row (and standalone item events): the item's own
 * type as words — `agentMessage` reads `Agent Message` — falling back to the
 * method when the notification carries no typed item.
 */
export function itemGroupTitle(event: RunEventView): string {
  const type = itemType(event);
  if (type) return formatMethodTitle(type);
  const openType = opencodeEventType(event);
  if (openType === "message.part.updated") {
    const part = asRecord(opencodeProperties(event).part);
    const partType = text(part.type);
    if (partType === "tool")
      return `${formatMethodTitle(text(part.tool) ?? "Tool")} Tool`;
    if (partType) return formatMethodTitle(partType);
  }
  const method = codexMethod(event);
  return method ? formatMethodTitle(method) : formatEnumLabel(event.type);
}

function eventItemId(event: RunEventView): string | null {
  const params = codexParams(event);
  return text(asRecord(params.item).id) ?? text(params.itemId);
}

/**
 * A single row, or an item folded from its lifecycle notifications. Codex emits
 * `item/started`, any number of `item/<kind>/delta`, and `item/completed` for
 * one logical item; grouping them collapses that run into one expandable row
 * whose children are the individual notifications.
 */
export type ActivityNode =
  | { kind: "single"; key: string; event: RunEventView }
  | {
      kind: "group";
      key: string;
      head: RunEventView;
      /** The event whose parsed content best represents the finished item. */
      representative: RunEventView;
      children: RunEventView[];
      /** Codex exposes its lifecycle; OpenCode exposes the combined result. */
      detailMode: "children" | "representative";
    };

function opencodePart(event: RunEventView): Record<string, unknown> {
  return asRecord(opencodeProperties(event).part);
}

function opencodePartId(event: RunEventView): string | null {
  if (opencodeEventType(event) === "message.part.delta")
    return text(opencodeProperties(event).partID);
  return text(opencodePart(event).id);
}

function opencodeMessageId(event: RunEventView): string | null {
  const properties = opencodeProperties(event);
  return text(properties.messageID) ?? text(opencodePart(event).messageID);
}

function combinedOpenCodeText(
  group: Extract<ActivityNode, { kind: "group" }>,
  type: "REASONING" | "ASSISTANT_MESSAGE",
): RunEventView {
  const value = group.children
    .map((child) => text(opencodeProperties(child).delta) ?? "")
    .join("");
  return {
    ...group.head,
    type,
    summary: value,
    detailMarkdown: value,
    raw: group.children.map((child) => child.raw),
  };
}

/**
 * Folds provider lifecycles into logical rows. Codex uses its item id from
 * `item/started` through completion. OpenCode uses the stable part id carried by
 * text deltas and tool updates; text is combined into one rendered result while
 * tool updates retain the final completed state.
 */
export function groupActivity(events: RunEventView[]): ActivityNode[] {
  const nodes: ActivityNode[] = [];
  const openCodex = new Map<string, Extract<ActivityNode, { kind: "group" }>>();
  const openCodeParts = new Map<
    string,
    Extract<ActivityNode, { kind: "group" }>
  >();
  const messagePartIds = new Map<string, string[]>();
  const messageFinishes = new Map<string, string>();

  for (const event of events) {
    const openType = opencodeEventType(event);
    if (openType === "message.part.delta") {
      const messageId = opencodeMessageId(event);
      const partId = opencodePartId(event);
      if (messageId && partId) {
        const ids = messagePartIds.get(messageId) ?? [];
        if (!ids.includes(partId)) ids.push(partId);
        messagePartIds.set(messageId, ids);
      }
    } else if (openType === "message.updated") {
      const info = asRecord(opencodeProperties(event).info);
      const id = text(info.id);
      const finish = text(info.finish);
      if (id && finish) messageFinishes.set(id, finish);
    }
  }

  for (const event of events) {
    const method = codexMethod(event);
    const id = method?.startsWith("item/") ? eventItemId(event) : null;
    if (method === "item/started" && id) {
      const group = {
        kind: "group" as const,
        key: `group:${event.id}`,
        head: event,
        representative: event,
        children: [event],
        detailMode: "children" as const,
      };
      nodes.push(group);
      openCodex.set(id, group);
      continue;
    }
    if (id && openCodex.has(id)) {
      const group = openCodex.get(id)!;
      group.children.push(event);
      if (method === "item/completed") {
        group.representative = event;
        openCodex.delete(id);
      }
      continue;
    }

    const openType = opencodeEventType(event);
    const partId = opencodePartId(event);
    const isDelta = openType === "message.part.delta";
    const isToolUpdate =
      openType === "message.part.updated" &&
      text(opencodePart(event).type) === "tool";
    if (partId && (isDelta || isToolUpdate)) {
      const existing = openCodeParts.get(partId);
      if (existing) {
        existing.children.push(event);
        if (isDelta) {
          const messageId = opencodeMessageId(event);
          const ids = messageId ? (messagePartIds.get(messageId) ?? []) : [];
          const finish = messageId ? messageFinishes.get(messageId) : null;
          const assistantMessage =
            (finish !== "tool-calls" && ids.length === 1 && Boolean(finish)) ||
            (ids.length > 1 && ids.at(-1) === partId);
          existing.representative = combinedOpenCodeText(
            existing,
            assistantMessage ? "ASSISTANT_MESSAGE" : "REASONING",
          );
        } else {
          existing.representative = event;
        }
        continue;
      }

      const group: Extract<ActivityNode, { kind: "group" }> = {
        kind: "group",
        key: `opencode:${partId}`,
        head: event,
        representative: event,
        children: [event],
        detailMode: "representative",
      };
      if (isDelta) {
        const messageId = opencodeMessageId(event);
        const ids = messageId ? (messagePartIds.get(messageId) ?? []) : [];
        const finish = messageId ? messageFinishes.get(messageId) : null;
        const assistantMessage =
          (finish !== "tool-calls" && ids.length === 1 && Boolean(finish)) ||
          (ids.length > 1 && ids.at(-1) === partId);
        group.representative = combinedOpenCodeText(
          group,
          assistantMessage ? "ASSISTANT_MESSAGE" : "REASONING",
        );
      }
      nodes.push(group);
      openCodeParts.set(partId, group);
      continue;
    }

    nodes.push({ kind: "single", key: event.id, event });
  }
  return nodes;
}
