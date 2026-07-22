import { join } from "node:path";

import PDFDocument from "pdfkit";

import { formatDateValue } from "@/lib/date-format";

import { telemetryFields } from "./fields";
import {
  DEFAULT_TELEMETRY_COLUMNS,
  type TelemetryEntryView,
  type TelemetryView,
} from "./types";

export type TelemetryExportFormat = "CSV" | "MARKDOWN" | "PDF";

export type TelemetryExportInput = {
  format: TelemetryExportFormat;
  view: TelemetryView;
  fields: string[];
  locale?: string | null;
  timeZone?: string | null;
  timeFormat?: "12" | "24" | null;
  filterSummary?: string | null;
};

const PDF_FONT = "TelemetryUnicode";
const PDF_EMOJI_FONT = "TelemetryEmoji";
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

type PdfGlyph = {
  emoji: boolean;
  value: string;
  width: number;
};

type PdfLine = {
  glyphs: PdfGlyph[];
  width: number;
};

function pdfGlyph(document: PDFKit.PDFDocument, value: string): PdfGlyph {
  const emoji = EMOJI_GRAPHEME.test(value);
  document.font(emoji ? PDF_EMOJI_FONT : PDF_FONT);
  return { emoji, value, width: document.widthOfString(value) };
}

function pdfLineHeight(document: PDFKit.PDFDocument): number {
  document.font(PDF_FONT);
  const textHeight = document.currentLineHeight(true);
  document.font(PDF_EMOJI_FONT);
  const emojiHeight = document.currentLineHeight(true);
  return Math.max(textHeight, emojiHeight);
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

function pdfTextHeight(
  document: PDFKit.PDFDocument,
  value: string,
  width: number,
): number {
  const lineHeight = pdfLineHeight(document);
  return layoutPdfText(document, value, width).length * lineHeight;
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
  const maxLines =
    options.lineBreak === false
      ? 1
      : options.height
        ? Math.max(1, Math.floor(options.height / lineHeight))
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
    const runs: Array<{ emoji: boolean; value: string; width: number }> = [];
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

const LABELS: Record<string, string> = {
  time: "Time",
  receivedAt: "Received",
  source: "Source",
  level: "Level",
  category: "Category",
  message: "Message",
  eventKind: "Kind",
  levelKind: "Level / Kind",
  eventName: "Name",
  screenName: "Screen Name",
  parameters: "Parameters",
  detail: "Detail",
  deviceIp: "Device IP",
  buildId: "Build ID",
  sessionId: "Session ID",
};

const FILTER_OPERATOR_LABELS: Record<string, string> = {
  CONTAINS: "contains",
  DOES_NOT_CONTAIN: "does not contain",
  IS: "is",
  IS_NOT: "is not",
  MATCHES_GLOB: "matches glob",
  MATCHES_REGEX: "matches regex",
  NO_REGEX_MATCH: "does not match regex",
  IS_EMPTY: "is empty",
  IS_NOT_EMPTY: "is not empty",
};

function stableDisplay(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function parameterText(entry: TelemetryEntryView): string {
  const values = telemetryFields(entry);
  return Object.entries(values)
    .filter(
      ([key]) =>
        key.startsWith("defaultParameters.") ||
        key.startsWith("defaultParameters[") ||
        key.startsWith("additionalParameters.") ||
        key.startsWith("additionalParameters["),
    )
    .map(([key, value]) => `${key}: ${stableDisplay(value)}`)
    .join(" • ");
}

function formattedTime(
  value: string,
  input: TelemetryExportInput,
  includeDate: boolean,
): string {
  return formatDateValue(value, includeDate ? "short" : "time", {
    locale: input.locale || "en",
    hour12: input.timeFormat !== "24",
    timeZone: input.timeZone ?? undefined,
  });
}

function fieldValue(
  entry: TelemetryEntryView,
  field: string,
  input: TelemetryExportInput,
): string {
  if (field === "time") return formattedTime(entry.clientTime, input, true);
  if (field === "receivedAt")
    return formattedTime(entry.receivedAt, input, true);
  if (field === "source")
    return entry.entryType === "CONSOLE" ? "Console" : "Analytics";
  if (field === "levelKind") return entry.level ?? entry.eventKind ?? "";
  if (field === "parameters") return parameterText(entry);
  if (field === "detail") {
    return entry.entryType === "CONSOLE"
      ? (entry.message ?? "")
      : `${entry.eventName ?? ""}${entry.screenName ? ` (${entry.screenName})` : ""}${parameterText(entry) ? ` - ${parameterText(entry)}` : ""}`;
  }
  return stableDisplay(telemetryFields(entry)[field]);
}

function safeFields(input: TelemetryExportInput): string[] {
  const fields = [
    ...new Set(input.fields.map((field) => field.trim()).filter(Boolean)),
  ];
  return fields.length
    ? fields.slice(0, 30)
    : DEFAULT_TELEMETRY_COLUMNS[input.view];
}

function label(field: string): string {
  if (LABELS[field]) return LABELS[field];
  return field
    .replace(/^attributes[.[]/, "")
    .replace(/^defaultParameters[.[]/, "Default: ")
    .replace(/^additionalParameters[.[]/, "Additional: ")
    .replace(/]$/g, "");
}

function pdfColumnWeight(field: string): number {
  if (field === "message" || field === "detail") return 2.8;
  if (field === "parameters") return 2.4;
  if (field === "time" || field === "receivedAt") return 1.35;
  if (field === "sessionId") return 1.2;
  if (field === "buildId" || field === "screenName") return 0.95;
  if (field === "category" || field === "eventName") return 0.9;
  if (
    field === "level" ||
    field === "eventKind" ||
    field === "levelKind" ||
    field === "source"
  ) {
    return 0.65;
  }
  if (
    field.startsWith("attributes.") ||
    field.startsWith("attributes[") ||
    field === "deviceIp"
  ) {
    return 0.8;
  }
  return 1;
}

function compactFilterValue(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function telemetryFilterLines(
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
  const summary = parsed as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof summary.search === "string" && summary.search.trim()) {
    const mode =
      summary.searchMode === "GLOB"
        ? "Glob"
        : summary.searchMode === "REGEX"
          ? "Regex"
          : "Text";
    lines.push(
      `Search - ${mode}, ${summary.caseSensitive === true ? "case-sensitive" : "case-insensitive"}: ${compactFilterValue(summary.search)}`,
    );
  }
  if (
    summary.quickFilters &&
    typeof summary.quickFilters === "object" &&
    !Array.isArray(summary.quickFilters)
  ) {
    for (const [field, rawValues] of Object.entries(summary.quickFilters)) {
      if (!Array.isArray(rawValues)) continue;
      const values = rawValues
        .map(compactFilterValue)
        .filter(Boolean)
        .slice(0, 20);
      if (values.length) {
        lines.push(`Quick filter - ${label(field)}: ${values.join(", ")}`);
      }
    }
  }
  if (
    summary.advancedFilter &&
    typeof summary.advancedFilter === "object" &&
    !Array.isArray(summary.advancedFilter)
  ) {
    const advanced = summary.advancedFilter as Record<string, unknown>;
    if (Array.isArray(advanced.conditions) && advanced.conditions.length) {
      lines.push(
        `Advanced filters - match ${advanced.mode === "ANY" ? "any" : "all"}:`,
      );
      for (const rawCondition of advanced.conditions) {
        if (
          !rawCondition ||
          typeof rawCondition !== "object" ||
          Array.isArray(rawCondition)
        ) {
          continue;
        }
        const condition = rawCondition as Record<string, unknown>;
        if (typeof condition.field !== "string") continue;
        const operator =
          typeof condition.operator === "string"
            ? (FILTER_OPERATOR_LABELS[condition.operator] ??
              condition.operator.toLocaleLowerCase().replaceAll("_", " "))
            : "matches";
        const value = compactFilterValue(condition.value);
        const sources = Array.isArray(condition.sources)
          ? condition.sources.filter(
              (source): source is string =>
                source === "CONSOLE" || source === "ANALYTICS",
            )
          : [];
        const scope =
          sources.length === 1
            ? ` [${sources[0] === "CONSOLE" ? "Console" : "Analytics"} only]`
            : "";
        const caseMode =
          condition.caseSensitive === true ? " (case-sensitive)" : "";
        lines.push(
          `${label(condition.field)} ${operator}${value ? ` "${value}"` : ""}${caseMode}${scope}`,
        );
      }
    }
  }
  return lines.length ? lines : ["None"];
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

function dayLabel(
  entry: TelemetryEntryView,
  input: TelemetryExportInput,
): string {
  return formatDateValue(entry.clientTime, "long", {
    locale: input.locale || "en",
    showTime: false,
    timeZone: input.timeZone ?? undefined,
  });
}

export function telemetryCsv(
  entries: TelemetryEntryView[],
  input: TelemetryExportInput,
): string {
  const fields = safeFields(input);
  const lines = [fields.map((field) => csvCell(label(field))).join(",")];
  let day = "";
  for (const entry of entries) {
    const nextDay = dayLabel(entry, input);
    if (nextDay !== day) {
      day = nextDay;
      lines.push(
        fields
          .map((_field, index) => csvCell(index === 0 ? `[Day] ${day}` : ""))
          .join(","),
      );
    }
    if (entry.entryType === "SEPARATOR") {
      lines.push(
        fields
          .map((_field, index) =>
            csvCell(
              index === 0
                ? `[Separator] ${entry.separatorName ?? ""}`.trim()
                : "",
            ),
          )
          .join(","),
      );
      continue;
    }
    lines.push(
      fields.map((field) => csvCell(fieldValue(entry, field, input))).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function telemetryMarkdown(
  entries: TelemetryEntryView[],
  input: TelemetryExportInput,
): string {
  const fields = safeFields(input);
  const lines = ["# Observability export", ""];
  if (input.filterSummary) {
    lines.push(`_Filters: ${input.filterSummary}_`, "");
  }
  let day = "";
  const header = `| ${fields.map((field) => markdownCell(label(field))).join(" | ")} |`;
  const rule = `| ${fields.map(() => "---").join(" | ")} |`;
  for (const entry of entries) {
    const nextDay = dayLabel(entry, input);
    if (nextDay !== day) {
      day = nextDay;
      lines.push(`## ${day}`, "", header, rule);
    }
    if (entry.entryType === "SEPARATOR") {
      lines.push(
        `| ${[
          `**${markdownCell(entry.separatorName || "Separator")}**`,
          ...fields.slice(1).map(() => ""),
        ].join(" | ")} |`,
      );
    } else {
      lines.push(
        `| ${fields.map((field) => markdownCell(fieldValue(entry, field, input))).join(" | ")} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function telemetryPdf(
  entries: TelemetryEntryView[],
  input: TelemetryExportInput,
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
      const length = chunks.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      );
      const output = new Uint8Array(length);
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
  const columnWeights = fields.map(pdfColumnWeight);
  const totalColumnWeight = columnWeights.reduce(
    (total, weight) => total + weight,
    0,
  );
  const columnWidths = columnWeights.map(
    (weight) => (width * weight) / totalColumnWeight,
  );
  let nextColumnX = document.page.margins.left;
  const columnXs = columnWidths.map((columnWidth) => {
    const x = nextColumnX;
    nextColumnX += columnWidth;
    return x;
  });
  const header = () => {
    document.font(PDF_FONT).fontSize(8).fillColor("#111111");
    const y = document.y;
    fields.forEach((field, index) => {
      writePdfText(document, label(field), columnXs[index]!, y, {
        width: columnWidths[index] - 6,
        lineBreak: false,
        ellipsis: true,
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
  const timelineDivider = (text: string) => {
    const textY = document.y + 5;
    document.fontSize(8).fillColor("#3f3f46");
    writePdfText(document, text, document.page.margins.left, textY, {
      width,
      align: "center",
      lineBreak: false,
      ellipsis: true,
    });
    const dividerY = textY + 14;
    document
      .save()
      .strokeColor("#dddddd")
      .moveTo(document.page.margins.left, dividerY)
      .lineTo(document.page.width - document.page.margins.right, dividerY)
      .stroke()
      .restore();
    document.x = document.page.margins.left;
    document.y = dividerY + 7;
  };
  document.font(PDF_FONT).fontSize(16).text("Observability export");
  document
    .font(PDF_FONT)
    .fontSize(8)
    .fillColor("#555555")
    .text(
      `Generated ${formattedTime(new Date().toISOString(), input, true)} - ${entries.filter((entry) => entry.entryType !== "SEPARATOR").length} records`,
    );
  const allFilterLines = telemetryFilterLines(input.filterSummary);
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
  document.font(PDF_FONT).fontSize(7).fillColor("#555555");
  filterLines.forEach((line, index) => {
    writePdfText(
      document,
      `- ${line}`,
      document.page.margins.left + 8,
      filterY + 18 + index * 10,
      {
        width: width - 16,
        lineBreak: false,
        ellipsis: true,
      },
    );
  });
  document.x = document.page.margins.left;
  document.y = filterY + filterHeight + 10;
  header();
  let day = "";
  for (const entry of entries) {
    const nextDay = dayLabel(entry, input);
    const dayChanged = nextDay !== day;
    const separator =
      entry.entryType === "SEPARATOR"
        ? (entry.separatorName || "Separator").replace(/[·—–‑]/g, "-")
        : null;
    document.font(PDF_FONT).fontSize(7);
    const values = separator
      ? []
      : fields.map((field) => truncatePdfCell(fieldValue(entry, field, input)));
    const naturalRowHeight = separator
      ? 0
      : Math.max(
          14,
          ...values.map((value, index) =>
            pdfTextHeight(document, value || " ", columnWidths[index] - 6),
          ),
        ) + 4;
    const freshRowCapacity =
      document.page.height -
      60 -
      document.page.margins.top -
      22 -
      (dayChanged ? 26 : 0);
    const boundedRowHeight = Math.min(
      naturalRowHeight,
      Math.max(14, freshRowCapacity),
    );
    const requiredHeight =
      (dayChanged ? 26 : 0) + (separator ? 26 : boundedRowHeight + 3);
    if (document.y + requiredHeight > document.page.height - 60) {
      document.addPage();
      header();
    }
    if (dayChanged) {
      day = nextDay;
      timelineDivider(day);
    }
    if (separator) {
      timelineDivider(separator);
      continue;
    }
    const y = document.y;
    const rowHeight = Math.min(
      naturalRowHeight,
      Math.max(14, document.page.height - 60 - y),
    );
    document.font(PDF_FONT).fontSize(7).fillColor("#111111");
    values.forEach((value, index) => {
      const height = Math.max(1, rowHeight - 4);
      writePdfText(document, value, columnXs[index]!, y, {
        width: columnWidths[index] - 6,
        height,
      });
    });
    document.x = document.page.margins.left;
    document.y = y + rowHeight;
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
