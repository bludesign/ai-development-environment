import { locales } from "@/i18n/routing";
import { requireUserRequest } from "@/services/auth";
import { getServerServices } from "@/services/server-services";
import {
  SSE_HISTORY_EXPORT_FIELDS,
  sseHistoryCsv,
  sseHistoryMarkdown,
  sseHistoryPdf,
  type SseHistoryExportFormat,
  type SseHistoryExportInput,
  type SseHistoryExportRow,
} from "@/services/sse/export";
import {
  SSE_ENDPOINT_MODES,
  SSE_HISTORY_EVENT_STAGES,
  SSE_HISTORY_VIEWS,
  type SseHistoryQueryInput,
} from "@/services/sse/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_EXPORT_BODY_BYTES = 256 * 1024;
const EXPORT_LOCALES = new Set<string>(locales);

class ExportPayloadTooLargeError extends Error {}

type ExportRequest = {
  format?: unknown;
  query?: unknown;
  ids?: unknown;
  fields?: unknown;
  locale?: unknown;
  timeZone?: unknown;
  timeFormat?: unknown;
  filterSummary?: unknown;
};

function bad(message: string, status = 400) {
  return Response.json(
    {
      error: {
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_EXPORT",
        message,
      },
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_EXPORT_BODY_BYTES) {
    throw new ExportPayloadTooLargeError();
  }
  if (!request.body) throw new Error("Export request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_EXPORT_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ExportPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function exportTimeZone(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown, maximum: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, maximum)
    : [];
}

function queryInput(value: unknown): SseHistoryQueryInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!SSE_HISTORY_VIEWS.includes(raw.view as never)) return null;
  const modes = stringArray(raw.modes, SSE_ENDPOINT_MODES.length);
  if (modes.some((mode) => !SSE_ENDPOINT_MODES.includes(mode as never))) {
    return null;
  }
  const stages = stringArray(raw.stages, SSE_HISTORY_EVENT_STAGES.length);
  if (
    stages.some((stage) => !SSE_HISTORY_EVENT_STAGES.includes(stage as never))
  ) {
    return null;
  }
  if (
    raw.searchMode !== undefined &&
    !["TEXT", "GLOB", "REGEX"].includes(String(raw.searchMode))
  ) {
    return null;
  }
  return {
    view: raw.view as SseHistoryQueryInput["view"],
    endpointId: typeof raw.endpointId === "string" ? raw.endpointId : null,
    modes: modes as NonNullable<SseHistoryQueryInput["modes"]>,
    statuses: stringArray(raw.statuses, 50),
    eventNames: stringArray(raw.eventNames, 100),
    stages: stages as NonNullable<SseHistoryQueryInput["stages"]>,
    search: typeof raw.search === "string" ? raw.search.slice(0, 10_000) : null,
    searchMode:
      raw.searchMode === "GLOB" || raw.searchMode === "REGEX"
        ? raw.searchMode
        : "TEXT",
    caseSensitive: raw.caseSensitive === true,
  };
}

async function matchingRows(
  query: SseHistoryQueryInput,
  ids: Set<string> | null,
): Promise<SseHistoryExportRow[]> {
  const rows: SseHistoryExportRow[] = [];
  let after: string | null = null;
  do {
    const page = await getServerServices().sseService.history({
      ...query,
      first: 500,
      after,
    });
    const pageRows = (page.view === "STREAMS" ? page.streams : page.events) as
      SseHistoryExportRow[] | undefined;
    rows.push(
      ...(pageRows ?? []).filter(
        (row) => !ids || (typeof row.id === "string" && ids.has(row.id)),
      ),
    );
    after = page.nextCursor;
  } while (after);
  return rows;
}

export async function POST(request: Request): Promise<Response> {
  const authenticationError = await requireUserRequest(request);
  if (authenticationError) return authenticationError;
  try {
    const body = (await readLimitedJson(request)) as ExportRequest;
    if (!body || typeof body !== "object") {
      return bad("Export request must be an object");
    }
    if (!(["CSV", "MARKDOWN", "PDF"] as const).includes(body.format as never)) {
      return bad("Unknown export format");
    }
    const query = queryInput(body.query);
    if (!query || !query.view) return bad("Valid export query is required");
    const locale =
      body.locale === null || body.locale === undefined || body.locale === ""
        ? null
        : typeof body.locale === "string" && EXPORT_LOCALES.has(body.locale)
          ? body.locale
          : undefined;
    if (locale === undefined) return bad("Unknown export locale");
    const timeZone = exportTimeZone(body.timeZone);
    if (timeZone === undefined) return bad("Unknown export time zone");
    const fields = stringArray(body.fields, 30);
    const allowedFields = new Set(SSE_HISTORY_EXPORT_FIELDS[query.view]);
    if (!fields.length || fields.some((field) => !allowedFields.has(field))) {
      return bad("At least one valid export field is required");
    }
    const ids = stringArray(body.ids, 100_000);
    const rows = await matchingRows(query, ids.length ? new Set(ids) : null);
    const input: SseHistoryExportInput = {
      format: body.format as SseHistoryExportFormat,
      view: query.view,
      fields,
      locale,
      timeZone,
      timeFormat: body.timeFormat === "24" ? "24" : "12",
      filterSummary:
        typeof body.filterSummary === "string"
          ? body.filterSummary.slice(0, 100_000)
          : null,
    };
    const date = new Date().toISOString().slice(0, 10);
    const basename = query.view === "EVENTS" ? "sse-events" : "sse-streams";
    if (input.format === "CSV") {
      return new Response(sseHistoryCsv(rows, input), {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${basename}-${date}.csv"`,
          "content-type": "text/csv; charset=utf-8",
        },
      });
    }
    if (input.format === "MARKDOWN") {
      return new Response(sseHistoryMarkdown(rows, input), {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${basename}-${date}.md"`,
          "content-type": "text/markdown; charset=utf-8",
        },
      });
    }
    const pdf = Uint8Array.from(await sseHistoryPdf(rows, input));
    return new Response(pdf.buffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${basename}-${date}.pdf"`,
        "content-type": "application/pdf",
      },
    });
  } catch (error) {
    if (error instanceof ExportPayloadTooLargeError) {
      return bad("Export request is too large", 413);
    }
    console.error("SSE history export failed:", error);
    return Response.json(
      {
        error: {
          code: "EXPORT_FAILED",
          message: error instanceof Error ? error.message : "Export failed",
        },
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
