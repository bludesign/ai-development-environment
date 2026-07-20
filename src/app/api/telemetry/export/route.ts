import { getServerServices } from "@/services/server-services";
import {
  TELEMETRY_VIEWS,
  type TelemetryQueryInput,
  type TelemetryView,
} from "@/services/telemetry";
import {
  telemetryCsv,
  telemetryMarkdown,
  telemetryPdf,
  type TelemetryExportFormat,
} from "@/services/telemetry/export";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_EXPORT_BODY_BYTES = 256 * 1024;

class ExportPayloadTooLargeError extends Error {}

type ExportRequest = {
  format?: unknown;
  query?: unknown;
  ids?: unknown;
  selection?: unknown;
  fields?: unknown;
  locale?: unknown;
  timeZone?: unknown;
  timeFormat?: unknown;
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

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await readLimitedJson(request)) as ExportRequest;
    if (!body || typeof body !== "object")
      return bad("Export request must be an object");
    if (!["CSV", "MARKDOWN", "PDF"].includes(String(body.format)))
      return bad("Unknown export format");
    if (
      !body.query ||
      typeof body.query !== "object" ||
      Array.isArray(body.query)
    )
      return bad("Export query is required");
    const query = body.query as TelemetryQueryInput;
    if (!TELEMETRY_VIEWS.includes(query.view as TelemetryView))
      return bad("Unknown telemetry view");
    const ids = Array.isArray(body.ids)
      ? body.ids
          .filter((id): id is string => typeof id === "string")
          .slice(0, 100_000)
      : null;
    const fields = Array.isArray(body.fields)
      ? body.fields
          .filter((field): field is string => typeof field === "string")
          .slice(0, 30)
      : [];
    const entries = await getServerServices().telemetryService.exportEntries({
      query,
      ids,
      selection:
        body.selection &&
        typeof body.selection === "object" &&
        !Array.isArray(body.selection)
          ? (body.selection as Parameters<
              ReturnType<
                typeof getServerServices
              >["telemetryService"]["clearSelected"]
            >[0])
          : null,
    });
    const input = {
      format: body.format as TelemetryExportFormat,
      view: query.view,
      fields,
      locale: typeof body.locale === "string" ? body.locale : null,
      timeZone: typeof body.timeZone === "string" ? body.timeZone : null,
      timeFormat: body.timeFormat === "24" ? ("24" as const) : ("12" as const),
      filterSummary: JSON.stringify({
        search: query.search ?? null,
        searchMode: query.searchMode ?? "TEXT",
        caseSensitive: query.caseSensitive === true,
        quickFilters: query.quickFilters ?? {},
        advancedFilter: query.advancedFilter ?? null,
      }),
    };
    const date = new Date().toISOString().slice(0, 10);
    if (input.format === "CSV") {
      return new Response(telemetryCsv(entries, input), {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="observability-${date}.csv"`,
          "content-type": "text/csv; charset=utf-8",
        },
      });
    }
    if (input.format === "MARKDOWN") {
      return new Response(telemetryMarkdown(entries, input), {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="observability-${date}.md"`,
          "content-type": "text/markdown; charset=utf-8",
        },
      });
    }
    const pdf = Uint8Array.from(await telemetryPdf(entries, input));
    return new Response(pdf.buffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="observability-${date}.pdf"`,
        "content-type": "application/pdf",
      },
    });
  } catch (error) {
    if (error instanceof ExportPayloadTooLargeError) {
      return bad("Export request is too large", 413);
    }
    console.error("Telemetry export failed:", error);
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
