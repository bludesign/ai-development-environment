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

/** The Codex envelope is the only one that carries a JSON-RPC `method`. */
export function codexMethod(event: RunEventView): string | null {
  const method = asRecord(event.raw).method;
  return typeof method === "string" && method.length ? method : null;
}

function codexParams(event: RunEventView): Record<string, unknown> {
  return asRecord(asRecord(event.raw).params);
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

/** One line of parsed detail: a technical field name and its formatted value. */
export type ActivityDetailRow = { label: string; value: string };

export type ActivityDescriptor = {
  icon: LucideIcon;
  /**
   * A readable title derived from the Codex method or item type; `null` for the
   * agent's own events, which carry a localized label the caller supplies.
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

/** The full parsed descriptor for one activity event. */
export function describeActivity(
  event: RunEventView,
  locale?: string,
): ActivityDescriptor {
  const icon = activityIcon(event);
  const method = codexMethod(event);
  if (!method) {
    return {
      icon,
      methodTitle: null,
      line: event.summary ?? "",
      detailRows: [],
    };
  }
  const formatter = new Intl.NumberFormat(locale ?? "en-US");
  const number = (value: number) => formatter.format(value);
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

/**
 * The title for a grouped item row (and standalone item events): the item's own
 * type as words — `agentMessage` reads `Agent Message` — falling back to the
 * method when the notification carries no typed item.
 */
export function itemGroupTitle(event: RunEventView): string {
  const type = itemType(event);
  if (type) return formatMethodTitle(type);
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
    };

/**
 * Folds an `item/started` → `item/<kind>/delta` … → `item/completed` run,
 * matched by item id, into a group node. Item notifications whose `item/started`
 * is not on the page (e.g. it paged in earlier) stay as their own single rows.
 */
export function groupActivity(events: RunEventView[]): ActivityNode[] {
  const nodes: ActivityNode[] = [];
  const open = new Map<string, Extract<ActivityNode, { kind: "group" }>>();
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
      };
      nodes.push(group);
      open.set(id, group);
      continue;
    }
    if (id && open.has(id)) {
      const group = open.get(id)!;
      group.children.push(event);
      if (method === "item/completed") {
        group.representative = event;
        open.delete(id);
      }
      continue;
    }
    nodes.push({ kind: "single", key: event.id, event });
  }
  return nodes;
}
