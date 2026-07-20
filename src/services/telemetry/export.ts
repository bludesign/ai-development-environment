import PDFDocument from "pdfkit";

import { telemetryFields } from "./matching";
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
  return new Intl.DateTimeFormat(input.locale || "en", {
    ...(includeDate ? { dateStyle: "medium" as const } : {}),
    timeStyle: "medium",
    hour12: input.timeFormat !== "24",
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  }).format(new Date(value));
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
      : `${entry.eventName ?? ""}${entry.screenName ? ` (${entry.screenName})` : ""}${parameterText(entry) ? ` — ${parameterText(entry)}` : ""}`;
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
    .replace(/^attributes[.[]/, "Attribute: ")
    .replace(/^defaultParameters[.[]/, "Default: ")
    .replace(/^additionalParameters[.[]/, "Additional: ")
    .replace(/]$/g, "");
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
  return new Intl.DateTimeFormat(input.locale || "en", {
    dateStyle: "full",
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  }).format(new Date(entry.clientTime));
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
  const columnWidth = width / fields.length;
  const header = () => {
    document.font("Helvetica-Bold").fontSize(8).fillColor("#111111");
    fields.forEach((field, index) => {
      document.text(
        label(field),
        document.page.margins.left + index * columnWidth,
        document.y,
        {
          width: columnWidth - 6,
          lineBreak: false,
          ellipsis: true,
        },
      );
    });
    document.moveDown(1.2);
    document
      .moveTo(document.page.margins.left, document.y)
      .lineTo(document.page.width - document.page.margins.right, document.y)
      .strokeColor("#aaaaaa")
      .stroke();
    document.moveDown(0.5);
  };
  document.font("Helvetica-Bold").fontSize(16).text("Observability export");
  document
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#555555")
    .text(
      `Generated ${new Date().toISOString()} · ${entries.filter((entry) => entry.entryType !== "SEPARATOR").length} records`,
    );
  if (input.filterSummary) {
    document.text(`Filters: ${input.filterSummary}`, {
      width,
      ellipsis: true,
      height: 24,
    });
  }
  document.moveDown();
  header();
  let day = "";
  for (const entry of entries) {
    if (document.y > document.page.height - 60) {
      document.addPage();
      header();
    }
    const nextDay = dayLabel(entry, input);
    if (nextDay !== day) {
      day = nextDay;
      document
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#333333")
        .text(day);
      document.moveDown(0.3);
    }
    if (entry.entryType === "SEPARATOR") {
      document.save();
      document
        .rect(document.page.margins.left, document.y, width, 16)
        .fill("#eeeeee");
      document
        .fillColor("#333333")
        .font("Helvetica-Bold")
        .fontSize(8)
        .text(
          entry.separatorName || "Separator",
          document.page.margins.left + 4,
          document.y + 4,
          { width: width - 8 },
        );
      document.restore();
      document.y += 18;
      continue;
    }
    const values = fields.map((field) => fieldValue(entry, field, input));
    const height = Math.min(
      42,
      Math.max(
        14,
        ...values.map((value) =>
          document.heightOfString(value || " ", { width: columnWidth - 6 }),
        ),
      ) + 4,
    );
    const y = document.y;
    document.font("Helvetica").fontSize(7).fillColor("#111111");
    values.forEach((value, index) => {
      document.text(
        value,
        document.page.margins.left + index * columnWidth,
        y,
        {
          width: columnWidth - 6,
          height,
          ellipsis: true,
        },
      );
    });
    document.y = y + height;
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
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#666666")
      .text(
        `Page ${index + 1} of ${pages.count}`,
        document.page.margins.left,
        document.page.height - 22,
        { align: "right", width },
      );
  }
  document.end();
  return completed;
}
