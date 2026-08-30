import { join } from "node:path";

import PDFDocument from "pdfkit";

import { formatDateValue } from "@/lib/date-format";

import type { SseHistoryQueryInput } from "./types";

export type SseHistoryExportFormat = "CSV" | "MARKDOWN" | "PDF";
export type SseHistoryExportView = "STREAMS" | "EVENTS";

export type SseHistoryExportInput = {
  format: SseHistoryExportFormat;
  view: SseHistoryExportView;
  fields: string[];
  locale?: string | null;
  timeZone?: string | null;
  timeFormat?: "12" | "24" | null;
  filterSummary?: string | null;
};

export type SseHistoryExportRow = Record<string, unknown>;

export const SSE_HISTORY_EXPORT_FIELDS: Record<
  SseHistoryExportView,
  readonly string[]
> = {
  STREAMS: [
    "endpoint",
    "startedAt",
    "method",
    "mode",
    "status",
    "responseStatus",
    "eventCount",
    "duration",
    "storedBytes",
  ],
  EVENTS: [
    "endpoint",
    "createdAt",
    "eventName",
    "stage",
    "eventId",
    "data",
    "sequence",
    "mode",
  ],
};

const LABELS: Record<string, string> = {
  endpoint: "Endpoint",
  startedAt: "Started At",
  createdAt: "Create At",
  method: "Method",
  mode: "Mode",
  status: "Status",
  responseStatus: "Response Status",
  eventCount: "Event Count",
  duration: "Duration",
  storedBytes: "Stored Bytes",
  eventName: "Event Name",
  stage: "Stage",
  eventId: "Event ID",
  data: "Data",
  sequence: "Sequence",
};

const PDF_FONT = "SseUnicode";
const PDF_EMOJI_FONT = "SseEmoji";
const PDF_FONT_PATH = join(
  process.cwd(),
  "node_modules",
  "@fontpkg",
  "unifont",
  "unifont-15.0.01.ttf",
);
const PDF_EMOJI_FONT_PATH = join(
  process.cwd(),
  "node_modules",
  "@expo-google-fonts",
  "noto-emoji",
  "400Regular",
  "NotoEmoji_400Regular.ttf",
);
const MAX_PDF_CELL_GRAPHEMES = 4_000;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const EMOJI_GRAPHEME =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\ufe0f/u;

function label(field: string): string {
  return LABELS[field] ?? field;
}

function safeFields(input: SseHistoryExportInput): string[] {
  const allowed = new Set(SSE_HISTORY_EXPORT_FIELDS[input.view]);
  const fields = [
    ...new Set(
      input.fields
        .map((field) => field.trim())
        .filter((field) => allowed.has(field)),
    ),
  ];
  return fields.length ? fields : [...SSE_HISTORY_EXPORT_FIELDS[input.view]];
}

function record(value: unknown): SseHistoryExportRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SseHistoryExportRow)
    : {};
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function requestFor(row: SseHistoryExportRow): SseHistoryExportRow {
  return record(row.request);
}

function formattedTime(value: unknown, input: SseHistoryExportInput): string {
  if (typeof value !== "string" || !value) return "";
  return formatDateValue(value, "short", {
    locale: input.locale || "en",
    hour12: input.timeFormat !== "24",
    timeZone: input.timeZone ?? undefined,
  });
}

function fieldValue(
  row: SseHistoryExportRow,
  field: string,
  input: SseHistoryExportInput,
): string {
  const request = requestFor(row);
  if (field === "endpoint") {
    return scalar(
      input.view === "STREAMS" ? row.endpointName : request.endpointName,
    );
  }
  if (field === "startedAt") return formattedTime(row.startedAt, input);
  if (field === "createdAt") return formattedTime(row.createdAt, input);
  if (field === "mode") {
    return scalar(input.view === "STREAMS" ? row.mode : request.mode);
  }
  if (field === "status") return scalar(row.outcome ?? row.status);
  if (field === "duration") {
    return row.durationMs === null || row.durationMs === undefined
      ? ""
      : `${scalar(row.durationMs)} ms`;
  }
  if (field === "storedBytes") {
    const value = scalar(row.storedBytes);
    return row.truncated === true && value ? `${value} (truncated)` : value;
  }
  return scalar(row[field]);
}

function rowTime(row: SseHistoryExportRow, view: SseHistoryExportView): string {
  const value = view === "STREAMS" ? row.startedAt : row.createdAt;
  return typeof value === "string" ? value : new Date(0).toISOString();
}

function dayLabel(
  row: SseHistoryExportRow,
  input: SseHistoryExportInput,
): string {
  return formatDateValue(rowTime(row, input.view), "long", {
    locale: input.locale || "en",
    showTime: false,
    timeZone: input.timeZone ?? undefined,
  });
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, "<br>");
}

export function sseHistoryCsv(
  rows: SseHistoryExportRow[],
  input: SseHistoryExportInput,
): string {
  const fields = safeFields(input);
  const lines = [fields.map((field) => csvCell(label(field))).join(",")];
  let day = "";
  for (const row of rows) {
    const nextDay = dayLabel(row, input);
    if (nextDay !== day) {
      day = nextDay;
      lines.push(
        fields
          .map((_field, index) => csvCell(index === 0 ? `[Day] ${day}` : ""))
          .join(","),
      );
    }
    lines.push(
      fields.map((field) => csvCell(fieldValue(row, field, input))).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function sseHistoryMarkdown(
  rows: SseHistoryExportRow[],
  input: SseHistoryExportInput,
): string {
  const fields = safeFields(input);
  const title =
    input.view === "EVENTS" ? "SSE Events export" : "SSE Streams export";
  const lines = [`# ${title}`, ""];
  const header = `| ${fields.map((field) => markdownCell(label(field))).join(" | ")} |`;
  const rule = `| ${fields.map(() => "---").join(" | ")} |`;
  let day = "";
  for (const row of rows) {
    const nextDay = dayLabel(row, input);
    if (nextDay !== day) {
      day = nextDay;
      lines.push(`## ${day}`, "", header, rule);
    }
    lines.push(
      `| ${fields
        .map((field) => markdownCell(fieldValue(row, field, input)))
        .join(" | ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function compact(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function sseHistoryFilterLines(
  filterSummary: string | null | undefined,
): string[] {
  if (!filterSummary) return ["None"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(filterSummary);
  } catch {
    return ["Custom filter applied"];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["None"];
  }
  const value = parsed as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof value.endpoint === "string" && value.endpoint.trim()) {
    lines.push(`Endpoint: ${compact(value.endpoint)}`);
  }
  for (const [key, title] of [
    ["modes", "Modes"],
    ["statuses", "Outcomes"],
    ["eventNames", "Event names"],
    ["stages", "Stages"],
  ] as const) {
    const values = Array.isArray(value[key])
      ? value[key].map(compact).filter(Boolean).slice(0, 20)
      : [];
    if (values.length) lines.push(`${title}: ${values.join(", ")}`);
  }
  if (typeof value.search === "string" && value.search.trim()) {
    const mode =
      value.searchMode === "GLOB"
        ? "Glob"
        : value.searchMode === "REGEX"
          ? "Regex"
          : "Text";
    lines.push(
      `Search - ${mode}, ${value.caseSensitive === true ? "case-sensitive" : "case-insensitive"}: ${compact(value.search)}`,
    );
  }
  return lines.length ? lines : ["None"];
}

type PdfGlyph = { emoji: boolean; value: string; width: number };
type PdfLine = { glyphs: PdfGlyph[]; width: number };

function truncatePdfCell(value: string): string {
  let output = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (count === MAX_PDF_CELL_GRAPHEMES) return `${output}…`;
    output += segment;
    count += 1;
  }
  return output;
}

function pdfGlyph(document: PDFKit.PDFDocument, value: string): PdfGlyph {
  const emoji = EMOJI_GRAPHEME.test(value);
  document.font(emoji ? PDF_EMOJI_FONT : PDF_FONT);
  return { emoji, value, width: document.widthOfString(value) };
}

function pdfLineHeight(document: PDFKit.PDFDocument): number {
  document.font(PDF_FONT);
  const textHeight = document.currentLineHeight(true);
  document.font(PDF_EMOJI_FONT);
  return Math.max(textHeight, document.currentLineHeight(true));
}

function layoutPdfText(
  document: PDFKit.PDFDocument,
  value: string,
  width: number,
  maxLines = Number.POSITIVE_INFINITY,
): PdfLine[] {
  const availableWidth = Math.max(1, width);
  const lines: PdfLine[] = [{ glyphs: [], width: 0 }];
  let truncated = false;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (/^[\r\n]+$/.test(segment)) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      lines.push({ glyphs: [], width: 0 });
      continue;
    }
    const glyph = pdfGlyph(document, segment);
    let line = lines.at(-1)!;
    if (line.glyphs.length && line.width + glyph.width > availableWidth) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      line = { glyphs: [], width: 0 };
      lines.push(line);
    }
    line.glyphs.push(glyph);
    line.width += glyph.width;
  }
  if (truncated) {
    const line = lines.at(-1)!;
    const ellipsis = pdfGlyph(document, "…");
    while (line.glyphs.length && line.width + ellipsis.width > availableWidth) {
      line.width -= line.glyphs.pop()!.width;
    }
    line.glyphs.push(ellipsis);
    line.width += ellipsis.width;
  }
  return lines;
}

function writePdfText(
  document: PDFKit.PDFDocument,
  value: string,
  x: number,
  y: number,
  options: PDFKit.Mixins.TextOptions,
): void {
  const width = Math.max(
    1,
    options.width ?? document.page.width - x - document.page.margins.right,
  );
  const lineHeight = pdfLineHeight(document);
  const maxLines = options.height
    ? Math.max(1, Math.floor(options.height / lineHeight))
    : options.lineBreak === false
      ? 1
      : Number.POSITIVE_INFINITY;
  const lines = layoutPdfText(document, value, width, maxLines);
  lines.forEach((line, lineIndex) => {
    const lineX =
      options.align === "center"
        ? x + (width - line.width) / 2
        : options.align === "right"
          ? x + width - line.width
          : x;
    let runX = lineX;
    const runs: PdfGlyph[] = [];
    for (const glyph of line.glyphs) {
      const last = runs.at(-1);
      if (last?.emoji === glyph.emoji) {
        last.value += glyph.value;
        last.width += glyph.width;
      } else {
        runs.push({ ...glyph });
      }
    }
    for (const run of runs) {
      document
        .font(run.emoji ? PDF_EMOJI_FONT : PDF_FONT)
        .text(run.value, runX, y + lineIndex * lineHeight, {
          lineBreak: false,
        });
      runX += run.width;
    }
  });
}

function pdfTextHeight(
  document: PDFKit.PDFDocument,
  value: string,
  width: number,
): number {
  return layoutPdfText(document, value, width).length * pdfLineHeight(document);
}

function columnWeight(field: string): number {
  if (field === "data") return 3.2;
  if (field === "endpoint") return 1.8;
  if (field === "startedAt" || field === "createdAt") return 1.35;
  if (field === "eventName" || field === "eventId") return 1.15;
  if (field === "status" || field === "responseStatus") return 0.85;
  if (field === "mode" || field === "stage" || field === "method") return 0.7;
  return 1;
}

export async function sseHistoryPdf(
  rows: SseHistoryExportRow[],
  input: SseHistoryExportInput,
): Promise<Uint8Array> {
  const fields = safeFields(input);
  const document = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margin: 32,
    bufferPages: true,
  });
  document.registerFont(PDF_FONT, PDF_FONT_PATH);
  document.registerFont(PDF_EMOJI_FONT, PDF_EMOJI_FONT_PATH);
  const chunks: Uint8Array[] = [];
  document.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const completed = new Promise<Uint8Array>((resolve, reject) => {
    document.on("end", () => {
      const output = new Uint8Array(
        chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(output);
    });
    document.on("error", reject);
  });
  const width =
    document.page.width -
    document.page.margins.left -
    document.page.margins.right;
  const weights = fields.map(columnWeight);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const columnWidths = weights.map((weight) => (width * weight) / totalWeight);
  let nextX = document.page.margins.left;
  const columnXs = columnWidths.map((columnWidth) => {
    const x = nextX;
    nextX += columnWidth;
    return x;
  });
  const tableHeader = () => {
    const y = document.y;
    document.font(PDF_FONT).fontSize(8).fillColor("#111111");
    fields.forEach((field, index) => {
      writePdfText(document, label(field), columnXs[index]!, y, {
        width: columnWidths[index]! - 6,
        lineBreak: false,
      });
    });
    document.x = document.page.margins.left;
    document.y = y + 12;
    document
      .moveTo(document.page.margins.left, document.y)
      .lineTo(document.page.width - document.page.margins.right, document.y)
      .strokeColor("#aaaaaa")
      .stroke();
    document.y += 5;
  };
  const divider = (text: string) => {
    const y = document.y + 5;
    document.font(PDF_FONT).fontSize(8).fillColor("#3f3f46");
    writePdfText(document, text, document.page.margins.left, y, {
      width,
      align: "center",
      lineBreak: false,
    });
    document
      .save()
      .strokeColor("#dddddd")
      .moveTo(document.page.margins.left, y + 14)
      .lineTo(document.page.width - document.page.margins.right, y + 14)
      .stroke()
      .restore();
    document.x = document.page.margins.left;
    document.y = y + 21;
  };

  const title =
    input.view === "EVENTS" ? "SSE Events export" : "SSE Streams export";
  document.font(PDF_FONT).fontSize(16).fillColor("#111111").text(title);
  document
    .font(PDF_FONT)
    .fontSize(8)
    .fillColor("#555555")
    .text(
      `Generated ${formattedTime(new Date().toISOString(), input)} - ${rows.length} records`,
    );
  const allFilterLines = sseHistoryFilterLines(input.filterSummary);
  const filterLines = allFilterLines.slice(0, 6);
  if (allFilterLines.length > filterLines.length) {
    filterLines[filterLines.length - 1] =
      `${allFilterLines.length - filterLines.length + 1} more filter conditions`;
  }
  const filterY = document.y + 5;
  const filterHeight = 20 + filterLines.length * 10;
  document
    .save()
    .lineWidth(0.5)
    .roundedRect(document.page.margins.left, filterY, width, filterHeight, 4)
    .fillAndStroke("#f7f7f8", "#dddddd")
    .restore();
  document
    .font(PDF_FONT)
    .fontSize(8)
    .fillColor("#333333")
    .text("Filters", document.page.margins.left + 8, filterY + 6, {
      width: width - 16,
      lineBreak: false,
    });
  filterLines.forEach((line, index) => {
    document.font(PDF_FONT).fontSize(7).fillColor("#555555");
    writePdfText(
      document,
      `- ${line}`,
      document.page.margins.left + 8,
      filterY + 18 + index * 10,
      { width: width - 16, lineBreak: false },
    );
  });
  document.x = document.page.margins.left;
  document.y = filterY + filterHeight + 10;
  tableHeader();

  let day = "";
  for (const row of rows) {
    const nextDay = dayLabel(row, input);
    const dayChanged = nextDay !== day;
    document.font(PDF_FONT).fontSize(7);
    const values = fields.map((field) =>
      truncatePdfCell(fieldValue(row, field, input)),
    );
    const naturalRowHeight =
      Math.max(
        14,
        ...values.map((value, index) =>
          pdfTextHeight(document, value || " ", columnWidths[index]! - 6),
        ),
      ) + 4;
    const freshCapacity =
      document.page.height -
      60 -
      document.page.margins.top -
      22 -
      (dayChanged ? 26 : 0);
    const rowHeight = Math.min(naturalRowHeight, Math.max(14, freshCapacity));
    if (
      document.y + (dayChanged ? 26 : 0) + rowHeight + 3 >
      document.page.height - 60
    ) {
      document.addPage();
      tableHeader();
    }
    if (dayChanged) {
      day = nextDay;
      divider(day);
    }
    const y = document.y;
    const availableRowHeight = Math.min(
      rowHeight,
      Math.max(14, document.page.height - 60 - y),
    );
    document.font(PDF_FONT).fontSize(7).fillColor("#111111");
    values.forEach((value, index) => {
      writePdfText(document, value, columnXs[index]!, y, {
        width: columnWidths[index]! - 6,
        height: Math.max(1, availableRowHeight - 4),
      });
    });
    document.x = document.page.margins.left;
    document.y = y + availableRowHeight;
    document
      .moveTo(document.page.margins.left, document.y)
      .lineTo(document.page.width - document.page.margins.right, document.y)
      .strokeColor("#dddddd")
      .stroke();
    document.y += 3;
  }
  const pages = document.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    document.switchToPage(index);
    document
      .font(PDF_FONT)
      .fontSize(7)
      .fillColor("#666666")
      .text(
        `Page ${index + 1} of ${pages.count}`,
        document.page.margins.left,
        document.page.height - document.page.margins.bottom - 10,
        { align: "right", width, lineBreak: false },
      );
  }
  document.end();
  return completed;
}

export function exportFilterSummary(
  query: SseHistoryQueryInput,
  endpoint: string | null,
): string {
  return JSON.stringify({
    endpoint,
    modes: query.modes ?? [],
    statuses: query.statuses ?? [],
    eventNames: query.eventNames ?? [],
    stages: query.stages ?? [],
    search: query.search ?? null,
    searchMode: query.searchMode ?? "TEXT",
    caseSensitive: query.caseSensitive === true,
  });
}
