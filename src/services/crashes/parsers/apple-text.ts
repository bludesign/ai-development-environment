import {
  CrashParseError,
  type NormalizedCrash,
  type NormalizedFrame,
  type NormalizedImage,
  type NormalizedThread,
} from "../types";
import { appleDate, isAppImage, optionalUuid, text, toHex } from "./common";

/**
 * The text crash format: what Xcode's Organizer exports, what devices wrote
 * before iOS 15, and what PLCrashReporter and KSCrash produce in apps.
 */

const HEADER_LINE = /^([A-Za-z][A-Za-z /-]*?):\s+(.*)$/;
const THREAD_HEADER = /^Thread (\d+)(?: name:\s*(.*)| (Crashed))?:?\s*$/;
const FRAME_LINE = /^(\d+)\s+(.+?)\s+(0x[0-9a-fA-F]+)\s+(.*?)\s*$/;
const BINARY_IMAGE =
  /^\s*(0x[0-9a-fA-F]+)\s*-\s*(0x[0-9a-fA-F]+|\?\?\?)\s+\+?(.+?)\s+(?:(arm64e|arm64_32|arm64|armv7k|armv7s|armv7|x86_64h|x86_64|i386)\s+)?(?:\([^)]*\)\s+)?<([0-9a-fA-F-]{32,36})>\s*(.*)$/;

type RawFrame = {
  imageName: string;
  address: bigint;
  rest: string;
};

function parseFrameLine(line: string): RawFrame | null {
  const match = FRAME_LINE.exec(line.trim());
  if (!match) return null;
  return {
    imageName: match[2]!.trim(),
    address: BigInt(match[3]!),
    rest: match[4]!,
  };
}

/**
 * Reads the text after a frame's address. It is either `0xBASE + OFFSET` for an
 * unsymbolicated frame, or `symbol + OFFSET (File.swift:12)`.
 */
function frameDetails(
  rest: string,
): Pick<
  NormalizedFrame,
  "symbol" | "symbolOffset" | "sourceFile" | "sourceLine"
> & { loadAddress: bigint | null; imageOffset: bigint | null } {
  const unsymbolicated = /^(0x[0-9a-fA-F]+)\s*\+\s*(\d+)$/.exec(rest);
  if (unsymbolicated) {
    return {
      loadAddress: BigInt(unsymbolicated[1]!),
      imageOffset: BigInt(unsymbolicated[2]!),
      symbol: null,
      symbolOffset: null,
      sourceFile: null,
      sourceLine: null,
    };
  }
  const symbolicated =
    /^(.*?)(?:\s+\+\s+(\d+))?(?:\s+\(([^()]+):(\d+)\))?(?:\s+\[inlined\])?$/.exec(
      rest,
    );
  return {
    loadAddress: null,
    imageOffset: null,
    symbol: text(symbolicated?.[1] ?? rest, 4_000),
    symbolOffset: symbolicated?.[2] ? Number(symbolicated[2]) : null,
    sourceFile: symbolicated?.[3] ?? null,
    sourceLine: symbolicated?.[4] ? Number(symbolicated[4]) : null,
  };
}

function imageFor(
  images: NormalizedImage[],
  name: string,
  address: bigint,
): NormalizedImage | undefined {
  let byName: NormalizedImage | undefined;
  for (const image of images) {
    if (!image.base) continue;
    const base = BigInt(image.base);
    const end = image.size === null ? null : base + BigInt(image.size);
    if (address >= base && (end === null || address < end)) return image;
    if (!byName && image.name === name) byName = image;
  }
  return byName;
}

function toFrame(raw: RawFrame, images: NormalizedImage[]): NormalizedFrame {
  const details = frameDetails(raw.rest);
  const image = imageFor(images, raw.imageName, raw.address);
  const base = image?.base ? BigInt(image.base) : details.loadAddress;
  const offset =
    details.imageOffset ?? (base !== null ? raw.address - base : null);
  return {
    imageIndex: image?.index ?? null,
    imageName: image?.name ?? raw.imageName,
    imageOffset: offset !== null && offset >= BigInt(0) ? toHex(offset) : null,
    address: toHex(raw.address),
    symbol: details.symbol,
    symbolOffset: details.symbolOffset,
    sourceFile: details.sourceFile,
    sourceLine: details.sourceLine,
  };
}

function parseImages(lines: string[]): NormalizedImage[] {
  const images: NormalizedImage[] = [];
  for (const line of lines) {
    const match = BINARY_IMAGE.exec(line);
    if (!match) continue;
    const base = BigInt(match[1]!);
    const end = match[2] === "???" ? null : BigInt(match[2]!);
    const path = text(match[6], 2_000);
    const name = match[3]!.trim();
    images.push({
      index: images.length,
      uuid: optionalUuid(match[5]),
      name,
      arch: match[4] ?? null,
      base: toHex(base),
      size: end === null ? null : Number(end - base + BigInt(1)),
      path,
      isApp: isAppImage(path, name),
    });
  }
  return images;
}

/**
 * The legacy one-line exception backtrace:
 * `(0x18e3c 0x18e40 ...)`, addresses only.
 */
function parseAddressList(
  line: string,
  images: NormalizedImage[],
): NormalizedFrame[] {
  return [...line.matchAll(/0x[0-9a-fA-F]+/g)].map((match) => {
    const address = BigInt(match[0]);
    const image = imageFor(images, "", address);
    const base = image?.base ? BigInt(image.base) : null;
    return {
      imageIndex: image?.index ?? null,
      imageName: image?.name ?? null,
      imageOffset: base !== null ? toHex(address - base) : null,
      address: toHex(address),
      symbol: null,
      symbolOffset: null,
      sourceFile: null,
      sourceLine: null,
    };
  });
}

export function looksLikeAppleTextCrash(contents: string): boolean {
  return (
    /^(Incident Identifier|Process|Exception Type):/m.test(contents) &&
    /^(Thread \d+|Binary Images:)/m.test(contents)
  );
}

export function parseAppleTextCrash(contents: string): NormalizedCrash {
  if (!looksLikeAppleTextCrash(contents)) {
    throw new CrashParseError("The file is not a .crash report");
  }
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = new Map<string, string>();
  const imageLines: string[] = [];
  const info: string[] = [];
  const threadLines = new Map<number, string[]>();
  const threadMeta = new Map<
    number,
    { name: string | null; crashed: boolean }
  >();
  let exceptionLines: string[] | null = null;
  let section: "HEADER" | "THREAD" | "IMAGES" | "INFO" | "EXCEPTION" | "OTHER" =
    "HEADER";
  let currentThread: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Binary Images:") {
      section = "IMAGES";
      continue;
    }
    if (/^Last Exception Backtrace:/.test(trimmed)) {
      section = "EXCEPTION";
      exceptionLines = [];
      const inline = trimmed.slice("Last Exception Backtrace:".length).trim();
      if (inline) exceptionLines.push(inline);
      continue;
    }
    if (/^Application Specific Information:/.test(trimmed)) {
      section = "INFO";
      continue;
    }
    const thread = THREAD_HEADER.exec(trimmed);
    if (thread && !/crashed with/.test(trimmed)) {
      const index = Number(thread[1]);
      const meta = threadMeta.get(index) ?? { name: null, crashed: false };
      if (thread[2] !== undefined) meta.name = thread[2]!.trim() || null;
      if (thread[3]) meta.crashed = true;
      threadMeta.set(index, meta);
      if (!threadLines.has(index)) threadLines.set(index, []);
      currentThread = index;
      section = "THREAD";
      continue;
    }
    if (/^Thread \d+ crashed with/.test(trimmed)) {
      section = "OTHER";
      continue;
    }
    if (section === "IMAGES") {
      if (trimmed) imageLines.push(line);
      continue;
    }
    if (section === "THREAD" && currentThread !== null) {
      if (!trimmed) {
        section = "OTHER";
        continue;
      }
      threadLines.get(currentThread)!.push(line);
      continue;
    }
    if (section === "EXCEPTION" && exceptionLines) {
      if (!trimmed) {
        if (exceptionLines.length) section = "OTHER";
        continue;
      }
      exceptionLines.push(line);
      continue;
    }
    if (section === "INFO") {
      if (!trimmed) {
        section = "OTHER";
        continue;
      }
      info.push(trimmed);
      continue;
    }
    const field = HEADER_LINE.exec(line);
    if (field && !header.has(field[1]!))
      header.set(field[1]!, field[2]!.trim());
  }

  const images = parseImages(imageLines);
  const threads: NormalizedThread[] = [...threadLines.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, entries]) => ({
      index,
      name: threadMeta.get(index)?.name ?? null,
      queue: null,
      crashed: threadMeta.get(index)?.crashed ?? false,
      frames: entries
        .map(parseFrameLine)
        .filter((frame): frame is RawFrame => frame !== null)
        .map((frame) => toFrame(frame, images)),
    }));
  if (!threads.length) {
    throw new CrashParseError("The .crash report has no thread backtraces");
  }

  let lastExceptionBacktrace: NormalizedFrame[] | null = null;
  if (exceptionLines?.length) {
    const parsed = exceptionLines
      .map(parseFrameLine)
      .filter((frame): frame is RawFrame => frame !== null);
    lastExceptionBacktrace = parsed.length
      ? parsed.map((frame) => toFrame(frame, images))
      : parseAddressList(exceptionLines.join(" "), images);
  }

  const triggered =
    header.get("Triggered by Thread") ?? header.get("Crashed Thread");
  const crashedIndex =
    triggered !== undefined && /^\d+/.test(triggered)
      ? Number(/^\d+/.exec(triggered)![0])
      : (threads.find((thread) => thread.crashed)?.index ?? null);
  for (const thread of threads) {
    if (thread.index === crashedIndex) thread.crashed = true;
  }

  const exceptionType = header.get("Exception Type") ?? null;
  const exceptionMatch = exceptionType
    ? /^(\S+)(?:\s+\((\S+)\))?/.exec(exceptionType)
    : null;
  const version = header.get("Version") ?? null;
  const versionMatch = version ? /^(.*?)\s*\((.*)\)\s*$/.exec(version) : null;
  const process = header.get("Process") ?? null;
  const processName = process ? process.replace(/\s*\[\d+\]\s*$/, "") : null;
  const reasonLine = info.find((line) => /reason: '/.test(line));
  const hardware = header.get("Hardware Model") ?? null;
  const codeType = header.get("Code Type") ?? null;

  return {
    format: "CRASH",
    incidentId: header.get("Incident Identifier") ?? null,
    appName: processName,
    bundleId: header.get("Identifier") ?? null,
    appVersion: versionMatch ? text(versionMatch[1], 200) : text(version, 200),
    buildVersion: versionMatch ? text(versionMatch[2], 200) : null,
    osVersion: header.get("OS Version") ?? null,
    deviceModel: hardware,
    arch: codeType ? codeType.replace(/\s*\(.*\)\s*$/, "") : null,
    processName,
    processPath: header.get("Path") ?? null,
    crashedAt: appleDate(header.get("Date/Time")),
    exceptionType: exceptionMatch?.[1] ?? exceptionType,
    exceptionCodes: header.get("Exception Codes") ?? null,
    signal: exceptionMatch?.[2] ?? null,
    exceptionSubtype: header.get("Exception Subtype") ?? null,
    exceptionReason: reasonLine
      ? (/reason: '(.+)'/.exec(reasonLine)?.[1] ?? null)
      : null,
    terminationReason: header.get("Termination Reason") ?? null,
    applicationSpecificInformation: info,
    crashedThread: crashedIndex,
    threads,
    lastExceptionBacktrace,
    images,
  };
}
