"use client";

import { useMemo } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { formatMethodTitle } from "./activity";
import { useRunLabels } from "./run-labels";
import type { AgentRunView } from "./types";

type ToolCall = AgentRunView["toolCalls"][number];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolType(call: ToolCall): string {
  const input = record(call.input);
  const item = record(record(input.params).item);
  if (typeof item.type === "string") return item.type;
  const part = record(record(input.properties).part);
  const content = record(input.message).content;
  const tool = Array.isArray(content)
    ? content.map(record).find((block) => block.type === "tool_use")
    : undefined;
  const name = String(part.tool ?? tool?.name ?? input.name ?? call.name);
  if (/^mcp[_.]/i.test(name)) return "mcpToolCall";
  if (
    /^(bash|shell|terminal|commandExecution|exec_command|write_stdin)$/i.test(
      name,
    )
  )
    return "commandExecution";
  if (/^(edit|write|multiedit|apply_patch|patch|fileChange)$/i.test(name))
    return "fileChange";
  if (/^(read|read_file|fileRead)$/i.test(name)) return "fileRead";
  if (/^(glob|grep|fileSearch)$/i.test(name)) return "fileSearch";
  if (/^(websearch|web_search|webfetch|web_fetch)$/i.test(name))
    return "webSearch";
  return name;
}

function toolCallLabel(call: ToolCall, type: string): string {
  if (type !== "webSearch") return call.name;
  const input = record(call.input);
  const item = record(record(input.params).item);
  const part = record(record(input.properties).part);
  const content = record(input.message).content;
  const tool = Array.isArray(content)
    ? content.map(record).find((block) => block.type === "tool_use")
    : undefined;
  for (const source of [
    record(item.action),
    item,
    record(record(part.state).input),
    record(tool?.input),
    record(input.input),
    input,
  ]) {
    const queries = Array.isArray(source.queries)
      ? source.queries.filter(
          (query): query is string =>
            typeof query === "string" && Boolean(query.trim()),
        )
      : [];
    if (queries.length) return queries.map((query) => query.trim()).join(" · ");
    if (typeof source.query === "string" && source.query.trim())
      return source.query.trim();
  }
  return call.name;
}

export function ToolCallGroups({ calls }: { calls: ToolCall[] }) {
  const t = useTranslations("runs");
  const locale = useLocale();
  const labels = useRunLabels();
  const groups = useMemo(() => {
    const byType = new Map<string, ToolCall[]>();
    for (const call of calls) {
      const type = toolType(call);
      const group = byType.get(type) ?? [];
      group.push(call);
      byType.set(type, group);
    }
    return [...byType];
  }, [calls]);

  return (
    <div className="min-w-0 max-w-full space-y-2">
      {groups.map(([type, group]) => (
        <details
          className="group/tool-type min-w-0 max-w-full overflow-hidden rounded-lg border"
          key={type}
        >
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 p-3 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 shrink-0 transition-transform group-open/tool-type:rotate-90" />
            <Wrench className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere]">
              {t.has(`toolCallTypes.${type}`)
                ? t(`toolCallTypes.${type}`)
                : formatMethodTitle(type)}
            </span>
            <Badge className="shrink-0 tabular-nums" variant="secondary">
              {group.length.toLocaleString(locale)}
            </Badge>
          </summary>
          <div className="min-w-0 space-y-2 border-t p-3">
            {group.map((call) => {
              const label = toolCallLabel(call, type);
              return (
                <details
                  className={cn(
                    "group/tool-call min-w-0 max-w-full overflow-hidden rounded-lg border",
                    call.supersededAt && "opacity-60",
                  )}
                  key={call.id}
                >
                  <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-2 p-3 [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-4 shrink-0 transition-transform group-open/tool-call:rotate-90" />
                    <span className="min-w-0 flex-1 truncate" title={label}>
                      {label}
                    </span>
                    <Badge className="shrink-0" variant="outline">
                      {labels.toolCallStatus(call.status)}
                    </Badge>
                    {call.supersededAt && (
                      <Badge className="shrink-0" variant="outline">
                        {t("superseded")}
                      </Badge>
                    )}
                  </summary>
                  <pre className="m-3 max-h-96 min-w-0 max-w-full overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {JSON.stringify(
                      {
                        name: call.name,
                        input: call.input,
                        output: call.output,
                        error: call.error,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}
