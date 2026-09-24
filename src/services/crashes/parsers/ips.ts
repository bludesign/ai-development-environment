import {
  CrashParseError,
  type NormalizedCrash,
  type NormalizedFrame,
  type NormalizedImage,
  type NormalizedThread,
} from "../types";
import {
  appleDate,
  hexValue,
  integer,
  isAppImage,
  optionalUuid,
  text,
  toHex,
} from "./common";

type JsonObject = Record<string, unknown>;

/** `bug_type` of an app crash. Other types (hangs, jetsam) carry no stack. */
const CRASH_BUG_TYPE = "309";

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * Splits an `.ips` file into its header line and body. The format is two JSON
 * documents back to back, so `JSON.parse` of the whole file fails; the header
 * always sits alone on the first line.
 */
export function splitIps(
  contents: string,
): { header: JsonObject; body: JsonObject } | null {
  const trimmed = contents.replace(/^\uFEFF/, "").trimStart();
  const newline = trimmed.indexOf("\n");
  if (newline < 0 || !trimmed.startsWith("{")) return null;
  let header: JsonObject | null;
  try {
    header = object(JSON.parse(trimmed.slice(0, newline)));
  } catch {
    return null;
  }
  if (!header || !("bug_type" in header)) return null;
  let body: JsonObject | null;
  try {
    body = object(JSON.parse(trimmed.slice(newline + 1)));
  } catch {
    throw new CrashParseError("The .ips report body is not valid JSON");
  }
  if (!body) throw new CrashParseError("The .ips report body is not an object");
  return { header, body };
}

function frames(value: unknown, images: NormalizedImage[]): NormalizedFrame[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry): NormalizedFrame => {
    const frame = object(entry) ?? {};
    const imageIndex = integer(frame.imageIndex);
    const image = imageIndex === null ? undefined : images[imageIndex];
    const offset = hexValue(frame.imageOffset);
    const base = image?.base ? BigInt(image.base) : null;
    return {
      imageIndex: image ? imageIndex : null,
      imageName: image?.name ?? null,
      imageOffset: offset === null ? null : toHex(offset),
      address: offset !== null && base !== null ? toHex(base + offset) : null,
      symbol: text(frame.symbol, 4_000),
      symbolOffset: integer(frame.symbolLocation),
      sourceFile: text(frame.sourceFile, 1_000),
      sourceLine: integer(frame.sourceLine),
    };
  });
}

function applicationSpecificInformation(body: JsonObject): string[] {
  const lines: string[] = [];
  const asi = object(body.asi);
  if (asi) {
    for (const [image, messages] of Object.entries(asi)) {
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        const line = text(message, 4_000);
        if (line) lines.push(`${image}: ${line}`);
      }
    }
  }
  const fault = object(body.os_fault);
  const faultProcess = text(fault?.process);
  if (faultProcess) lines.push(`os_fault: ${faultProcess}`);
  return lines;
}

/** Pulls an uncaught `NSException`'s reason out of the application info. */
function exceptionReason(lines: string[], body: JsonObject): string | null {
  const reason = object(body.exceptionReason);
  const composed = text(reason?.composed_message, 4_000);
  if (composed) return composed;
  for (const line of lines) {
    const match = /reason: '([\s\S]+)'/.exec(line);
    if (match) return match[1]!.slice(0, 4_000);
  }
  return null;
}

export function parseIps(contents: string): NormalizedCrash {
  const parts = splitIps(contents);
  if (!parts) throw new CrashParseError("The file is not an .ips report");
  const { header, body } = parts;
  const bugType = String(header.bug_type ?? "");
  if (bugType !== CRASH_BUG_TYPE) {
    throw new CrashParseError(
      `Only crash reports (bug_type ${CRASH_BUG_TYPE}) can be symbolicated; this report has bug_type ${bugType || "missing"}`,
    );
  }
  const images: NormalizedImage[] = (
    Array.isArray(body.usedImages) ? body.usedImages : []
  ).map((entry, index): NormalizedImage => {
    const image = object(entry) ?? {};
    const path = text(image.path, 2_000);
    const name =
      text(image.name, 500) ??
      (path ? path.split("/").pop()! : `image-${index}`);
    const base = hexValue(image.base);
    const uuid = optionalUuid(image.uuid);
    return {
      index,
      uuid,
      name,
      arch: text(image.arch, 32),
      base: base === null ? null : toHex(base),
      size: integer(image.size),
      path,
      // `source: "A"` marks the placeholder for absolute addresses, which has
      // no binary behind it.
      isApp: uuid !== null && image.source !== "A" && isAppImage(path, name),
    };
  });
  const faulting = integer(body.faultingThread);
  const threads: NormalizedThread[] = (
    Array.isArray(body.threads) ? body.threads : []
  ).map((entry, index): NormalizedThread => {
    const thread = object(entry) ?? {};
    return {
      index,
      name: text(thread.name, 500),
      queue: text(thread.queue, 500),
      crashed: thread.triggered === true || faulting === index,
      frames: frames(thread.frames, images),
    };
  });
  const exception = object(body.exception) ?? {};
  const termination = object(body.termination);
  const info = applicationSpecificInformation(body);
  const osVersion = object(body.osVersion);
  const bundleInfo = object(body.bundleInfo);
  const terminationReason = termination
    ? [
        text(termination.namespace),
        integer(termination.code) ?? text(termination.code),
        text(termination.indicator),
      ]
        .filter((part) => part !== null && part !== "")
        .join(" ")
    : null;
  return {
    format: "IPS",
    incidentId: text(header.incident_id, 100) ?? text(body.incident, 100),
    appName: text(header.app_name, 500) ?? text(body.procName, 500),
    bundleId:
      text(header.bundleID, 500) ?? text(bundleInfo?.CFBundleIdentifier, 500),
    appVersion:
      text(header.app_version, 200) ??
      text(bundleInfo?.CFBundleShortVersionString, 200),
    buildVersion:
      text(header.build_version, 200) ?? text(bundleInfo?.CFBundleVersion, 200),
    osVersion:
      text(header.os_version, 200) ??
      (osVersion
        ? [text(osVersion.train), text(osVersion.build)]
            .filter(Boolean)
            .join(" ")
        : null),
    deviceModel: text(body.modelCode, 200),
    arch: text(body.cpuType, 100),
    processName: text(body.procName, 500),
    processPath: text(body.procPath, 2_000),
    crashedAt: appleDate(header.timestamp) ?? appleDate(body.captureTime),
    exceptionType: text(exception.type, 200),
    exceptionCodes: text(exception.codes, 500),
    signal: text(exception.signal, 100),
    exceptionSubtype: text(exception.subtype, 1_000),
    exceptionReason: exceptionReason(info, body),
    terminationReason: terminationReason || null,
    applicationSpecificInformation: info,
    crashedThread:
      faulting ?? threads.find((thread) => thread.crashed)?.index ?? null,
    threads,
    lastExceptionBacktrace: Array.isArray(body.lastExceptionBacktrace)
      ? frames(body.lastExceptionBacktrace, images)
      : null,
    images,
  };
}
