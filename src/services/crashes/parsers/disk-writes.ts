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

const FIELD = /^([A-Za-z][\w /-]*):\s*(.+)$/;
const IMAGE =
  /^\s*(0x[\da-f]+)\s*-\s*(0x[\da-f]+|\?\?\?)\s+(.+?)\s+<([\da-f-]+)>\s*(.*?)\s*$/i;
const FRAME =
  /^(\s*)(\d+)\s+(.+?)\s+\((.+?)\s+\+\s+(\d+)\)\s+\[(0x[\da-f]+)\]/i;
const AMOUNT = /(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|bytes?|B)\b/i;
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
    const match = FIELD.exec(line);
    if (match && !result.has(match[1]!))
      result.set(match[1]!, match[2]!.trim());
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
    const match = IMAGE.exec(line);
    if (!match) continue;
    const [, start, end, label, rawUuid, rawPath] = match;
    const path = text(rawPath);
    const imageArch = label!.match(
      /\b(?:arm64e?|arm64_32|x86_64h?|i386)\b/,
    )?.[0];
    const name = path?.split("/").pop() ?? label!.split(/\s/)[0]!;
    const base = BigInt(start!);
    const size = end === "???" ? null : Number(BigInt(end!) - base + BigInt(1));
    images.push({
      index: images.length,
      uuid: optionalUuid(rawUuid),
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

function readFrame(line: string, imagesByBase: Map<string, NormalizedImage[]>) {
  const match = FRAME.exec(line);
  if (!match) return null;
  const [, indent, samples, label, imageName, offsetText, addressText] = match;
  const sampleCount = count(samples);
  if (sampleCount === null) return null;
  const address = BigInt(addressText!);
  const offset = BigInt(offsetText!);
  // The explicit offset identifies the image even when its address range is open-ended.
  const candidates =
    address >= offset ? (imagesByBase.get(toHex(address - offset)) ?? []) : [];
  const image =
    candidates.find((entry) => entry.name === imageName) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  const symbol = label!.match(/^(.*?)\s+\+\s+(\d+)$/);
  const frame: NormalizedFrame = {
    imageIndex: image?.index ?? null,
    imageName: text(imageName, 500),
    imageOffset: toHex(offset),
    address: toHex(address),
    symbol: label === "???" ? null : text(symbol?.[1] ?? label, 4000),
    symbolOffset: numberIn(symbol?.[2]),
    sourceFile: null,
    sourceLine: null,
  };
  return {
    indentation: indent!.replaceAll("\t", "        ").length,
    sampleCount,
    frame,
  };
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
  const imagesByBase = new Map<string, NormalizedImage[]>();
  for (const image of images) {
    const base = image.base!;
    const matches = imagesByBase.get(base) ?? [];
    matches.push(image);
    imagesByBase.set(base, matches);
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
  const power = fields(powerLines);
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
  const version = /^(.*?)\s+\(([^()]+)\)$/.exec(report.get("Version") ?? "");
  const steps = report.get("Steps");
  const durationMs = numberIn(text(header.duration_ms) ?? undefined);
  const action = text(report.get("Action taken"), 200);
  const average = quantity(
    writes?.match(/\(([^()]+?)\s+per second average\)/i)?.[1],
  );
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
      text(version?.[1] ?? report.get("Version"), 200),
    buildVersion: text(header.build_version, 200) ?? text(version?.[2], 200),
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
      averageBytesPerSecond: average,
      startedAt: appleDate(report.get("Date/Time")),
      endedAt: appleDate(report.get("End time")),
      reportedAt: appleDate(header.timestamp),
      action,
      sampledDurationSeconds: numberIn(report.get("Duration Sampled")),
      samplesCaptured: count(power.get("Num samples")) ?? count(steps),
      samplesLost: count(steps?.match(/(\d+)\s+samples? lost/i)?.[1]),
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
