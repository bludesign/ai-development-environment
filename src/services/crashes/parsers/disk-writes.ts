import {
  CrashParseError,
  DISK_WRITES_FORMAT,
  type NormalizedCrash,
  type NormalizedFrame,
  type NormalizedImage,
  type SampledFrame,
  type SampledNode,
} from "../types";
import { appleDate, isAppImage, optionalUuid, text, toHex } from "./common";

type Header = Record<string, unknown>;

const FIELD_NAME = /^[A-Za-z][\w /-]*$/;
const IMAGE_RANGE = /^\s*(0x[\da-f]{1,16})\s*-\s*(0x[\da-f]{1,16}|\?\?\?)\s+/i;
const IMAGE_UUID = /(?<!\s)\s+<([\da-f-]{1,36})>/i;
const FRAME_COUNT = /^(\s*)(\d{1,10})\s+/;
const FRAME_ADDRESS = /\)\s+\[(0x[\da-f]{1,16})\]/i;
const TRAILING_OFFSET = /(?<!\s)\s+\+\s+(\d{1,20})$/;
const AMOUNT =
  /^\s*(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|bytes?|B)\b/i;
const UNITS: Record<string, number> = {
  byte: 1,
  bytes: 1,
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

function quantity(value?: string): number | null {
  const match = AMOUNT.exec(value ?? "");
  if (!match) return null;
  const bytes = Math.round(Number(match[1]) * UNITS[match[2]!.toLowerCase()]!);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function numberIn(value?: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)/.exec(value ?? "");
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER
    ? number
    : null;
}

function count(value?: string): number | null {
  const number = numberIn(value);
  return number !== null && Number.isInteger(number) && number <= 2_147_483_647
    ? number
    : null;
}

function fields(lines: string[]) {
  const result = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    if (!FIELD_NAME.test(name) || result.has(name)) continue;
    const value = line.slice(separator + 1).trim();
    if (value) result.set(name, value);
  }
  return result;
}

function binaryImages(
  lines: string[],
  arch: string | null,
  processPath: string | null,
) {
  const images: NormalizedImage[] = [];
  for (const line of lines) {
    const range = IMAGE_RANGE.exec(line);
    if (!range) continue;
    const description = line.slice(range[0].length);
    const uuid = IMAGE_UUID.exec(description);
    if (!uuid) continue;
    const label = description.slice(0, uuid.index).trim();
    if (!label) continue;
    const path = text(description.slice(uuid.index + uuid[0].length));
    const imageArch = label.match(
      /\b(?:arm64e?|arm64_32|x86_64h?|i386)\b/,
    )?.[0];
    const name = path?.split("/").pop() ?? label.split(/\s/, 1)[0]!;
    const [, start, end] = range;
    const base = BigInt(start!);
    const size = end === "???" ? null : Number(BigInt(end!) - base + BigInt(1));
    images.push({
      index: images.length,
      uuid: optionalUuid(uuid[1]),
      name,
      arch: imageArch ?? (path && path === processPath ? arch : null),
      base: toHex(base),
      size:
        size !== null && Number.isSafeInteger(size) && size > 0 ? size : null,
      path,
      isApp: isAppImage(path, name),
    });
  }
  return images;
}

function matchingOpenParen(value: string, end: number): number {
  let depth = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (value[index] === ")") depth += 1;
    if (value[index] !== "(") continue;
    if (depth === 0) return index;
    depth -= 1;
  }
  return -1;
}

type ImagesByBase = Map<
  string,
  { byName: Map<string, NormalizedImage>; fallback?: NormalizedImage }
>;

function readFrame(line: string, imagesByBase: ImagesByBase) {
  const prefix = FRAME_COUNT.exec(line);
  if (!prefix) return null;
  const sampleCount = count(prefix[2]);
  if (sampleCount === null) return null;

  // Read the image reference from the address back toward the symbol so
  // parentheses in demangled names cannot be mistaken for the image reference.
  const addressMatch = FRAME_ADDRESS.exec(line);
  if (!addressMatch) return null;
  const reference = line.slice(prefix[0].length, addressMatch.index);
  const imageOffset = TRAILING_OFFSET.exec(reference);
  if (!imageOffset) return null;
  const openingParen = matchingOpenParen(reference, imageOffset.index);
  if (openingParen <= 0) return null;
  const label = reference.slice(0, openingParen).trimEnd();
  const imageName = reference.slice(openingParen + 1, imageOffset.index).trim();
  if (!label || !imageName) return null;

  const address = BigInt(addressMatch[1]!);
  const offset = BigInt(imageOffset[1]!);
  // The explicit offset identifies the image even when its address range is open-ended.
  const candidates =
    address >= offset ? imagesByBase.get(toHex(address - offset)) : undefined;
  const image = candidates?.byName.get(imageName) ?? candidates?.fallback;
  const symbolOffset = TRAILING_OFFSET.exec(label);
  const frame: NormalizedFrame = {
    imageIndex: image?.index ?? null,
    imageName: text(imageName, 500),
    imageOffset: toHex(offset),
    address: toHex(address),
    symbol:
      label === "???"
        ? null
        : text(symbolOffset ? label.slice(0, symbolOffset.index) : label, 4000),
    symbolOffset: numberIn(symbolOffset?.[1]),
    sourceFile: null,
    sourceLine: null,
  };
  return {
    indentation: prefix[1]!.replaceAll("\t", "        ").length,
    sampleCount,
    frame,
  };
}

function averageWriteRate(writes?: string): number | null {
  for (const [, details] of (writes ?? "").matchAll(/\(([^()]*)\)/g)) {
    if (/\sper second average$/i.test(details!)) return quantity(details);
  }
  return null;
}

/** Apple's device export has a one-line JSON header followed by a Microstackshots text report. */
export function parseDiskWritesIps(
  header: Header,
  body: string,
): NormalizedCrash {
  const lines = body.split(/\r?\n/);
  const heaviestAt = lines.findIndex((line) =>
    /^Heaviest stack for the target process:/i.test(line.trim()),
  );
  const powerAt = lines.findIndex((line) =>
    /^Powerstats for:/i.test(line.trim()),
  );
  const imagesAt = lines.findIndex((line) => line.trim() === "Binary Images:");
  const firstSection = [heaviestAt, powerAt, imagesAt].filter(
    (index) => index >= 0,
  );
  const headerLines = lines.slice(
    0,
    firstSection.length ? Math.min(...firstSection) : lines.length,
  );
  const report = fields(headerLines);
  if (report.get("Event")?.toLowerCase() !== "disk writes") {
    throw new CrashParseError(
      "Unsupported resource report. Upload an .ips report whose event is disk writes",
    );
  }

  const writes = report.get("Writes");
  const writesBytes = quantity(report.get("Writes caused")) ?? quantity(writes);
  if (writesBytes === null)
    throw new CrashParseError(
      "The disk write report is missing a valid write volume",
    );

  // A device architecture can precede Command, and differ from the app's slice.
  const commandAt = headerLines.findIndex((line) =>
    line.startsWith("Command:"),
  );
  const target = commandAt < 0 ? report : fields(headerLines.slice(commandAt));
  const arch = text(
    target.get("Architecture") ?? report.get("Architecture"),
    100,
  );
  const processPath = text(report.get("Path"));
  const images =
    imagesAt === -1
      ? []
      : binaryImages(lines.slice(imagesAt + 1), arch, processPath);
  const imagesByBase: ImagesByBase = new Map();
  for (const image of images) {
    const base = image.base!;
    const matches = imagesByBase.get(base);
    if (!matches) {
      imagesByBase.set(base, {
        byName: new Map([[image.name, image]]),
        fallback: image,
      });
      continue;
    }
    matches.fallback = undefined;
    if (!matches.byName.has(image.name)) matches.byName.set(image.name, image);
  }

  const heaviestStack: SampledFrame[] = [];
  const callTree: SampledNode[] = [];
  if (heaviestAt !== -1) {
    const end = [powerAt, imagesAt].filter((index) => index > heaviestAt);
    for (const line of lines.slice(
      heaviestAt + 1,
      end.length ? Math.min(...end) : undefined,
    )) {
      const entry = readFrame(line, imagesByBase);
      if (entry)
        heaviestStack.push({
          sampleCount: entry.sampleCount,
          frame: entry.frame,
        });
    }
  }

  const powerLines =
    powerAt === -1
      ? []
      : lines.slice(powerAt + 1, imagesAt > powerAt ? imagesAt : undefined);
  const ancestors: { id: number; indentation: number }[] = [];
  for (const line of powerLines) {
    if (/^Powerstats for:/i.test(line.trim())) break;
    const entry = readFrame(line, imagesByBase);
    if (!entry) continue;
    while (
      ancestors.length &&
      ancestors.at(-1)!.indentation >= entry.indentation
    )
      ancestors.pop();
    const id = callTree.length;
    callTree.push({
      id,
      parentId: ancestors.at(-1)?.id ?? null,
      sampleCount: entry.sampleCount,
      frame: entry.frame,
    });
    ancestors.push({ id, indentation: entry.indentation });
  }

  const processName = text(report.get("Command"), 500);
  const version = report.get("Version") ?? "";
  const build = /(?<!\s)\s+\(([^()]+)\)$/.exec(version);
  const steps = report.get("Steps");
  const durationMs = numberIn(text(header.duration_ms) ?? undefined);
  const action = text(report.get("Action taken"), 200);
  return {
    format: DISK_WRITES_FORMAT,
    incidentId:
      text(header.incident_id, 100) ??
      text(report.get("Incident Identifier"), 100),
    appName:
      text(header.app_name, 500) ?? processName ?? text(header.name, 500),
    bundleId: text(header.bundleID, 500) ?? text(report.get("Identifier"), 500),
    appVersion:
      text(header.app_version, 200) ??
      text(build ? version.slice(0, build.index) : version, 200),
    buildVersion: text(header.build_version, 200) ?? text(build?.[1], 200),
    osVersion:
      text(header.os_version, 200) ?? text(report.get("OS Version"), 200),
    deviceModel: text(report.get("Hardware model"), 200),
    arch,
    processName,
    processPath,
    crashedAt: null,
    exceptionType: null,
    exceptionCodes: null,
    signal: null,
    exceptionSubtype: null,
    exceptionReason: null,
    terminationReason: null,
    applicationSpecificInformation: [],
    crashedThread: null,
    threads: [],
    lastExceptionBacktrace: null,
    images,
    diskWrites: {
      writesBytes,
      limitBytes: quantity(report.get("Writes limit")),
      limitDurationSeconds: numberIn(report.get("Limit duration")),
      durationSeconds:
        numberIn(report.get("Duration")) ??
        (durationMs === null ? null : durationMs / 1000) ??
        numberIn(report.get("Writes duration")),
      averageBytesPerSecond: averageWriteRate(writes),
      startedAt: appleDate(report.get("Date/Time")),
      endedAt: appleDate(report.get("End time")),
      reportedAt: appleDate(header.timestamp),
      action,
      sampledDurationSeconds: numberIn(report.get("Duration Sampled")),
      samplesCaptured: count(steps),
      samplesLost: count(steps?.match(/(?<!\d)(\d+)\s+samples? lost/i)?.[1]),
      distributor: text(header.distributor_id, 200),
      isBeta:
        header.is_beta === 1 ||
        header.is_beta === true ||
        report.get("Is Beta") === "Yes"
          ? true
          : header.is_beta === 0 ||
              header.is_beta === false ||
              report.get("Is Beta") === "No"
            ? false
            : null,
      heaviestStack,
      callTree,
    },
  };
}
