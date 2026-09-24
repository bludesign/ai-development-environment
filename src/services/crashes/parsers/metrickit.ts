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
  isAppImage,
  machExceptionName,
  optionalUuid,
  signalName,
  text,
  toHex,
} from "./common";

/**
 * MetricKit crash diagnostics, as an app receives them in
 * `MXMetricManagerSubscriber.didReceive(_: [MXDiagnosticPayload])` and sends
 * with `jsonRepresentation()`. Accepts one payload, an array of payloads, or a
 * single `MXCrashDiagnostic`.
 */

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * Load addresses sit on a page boundary. Images inside the dyld shared cache
 * are packed at 4 KiB even on 16 KiB-page devices, so test the smaller size.
 */
const PAGE_SIZE = BigInt(0x1000);

type RawFrame = {
  uuid: string | null;
  name: string;
  address: bigint | null;
  offsetValue: bigint | null;
};

/**
 * Follows a root frame down its `subFrames`. Crash stacks are a single chain:
 * the root is the frame that crashed and each sub-frame is its caller.
 */
function flatten(root: unknown): RawFrame[] {
  const frames: RawFrame[] = [];
  let current = object(root);
  while (current && frames.length < 512) {
    frames.push({
      uuid: optionalUuid(current.binaryUUID),
      name: text(current.binaryName, 500) ?? "???",
      address: hexValue(current.address),
      offsetValue: hexValue(current.offsetIntoBinaryTextSegment),
    });
    const sub = Array.isArray(current.subFrames) ? current.subFrames : [];
    current = object(sub[0]);
  }
  return frames;
}

/**
 * Works out each binary's load address.
 *
 * `offsetIntoBinaryTextSegment` is documented as the frame's offset into the
 * binary, but several OS releases put the binary's load address there instead.
 * When every frame of one binary reports the same value, and that value is a
 * page-aligned address no larger than the frames' own addresses, it is a load
 * address; otherwise it is the offset and the load address is the difference.
 */
function loadAddresses(frames: RawFrame[]): Map<string, bigint | null> {
  const byBinary = new Map<string, RawFrame[]>();
  for (const frame of frames) {
    const key = frame.uuid ?? frame.name;
    const list = byBinary.get(key) ?? [];
    list.push(frame);
    byBinary.set(key, list);
  }
  const result = new Map<string, bigint | null>();
  for (const [key, list] of byBinary) {
    const values = new Set(list.map((frame) => frame.offsetValue));
    const [value] = values;
    const looksLikeLoadAddress =
      values.size === 1 &&
      value !== null &&
      value !== undefined &&
      value % PAGE_SIZE === BigInt(0) &&
      list.every((frame) => frame.address !== null && frame.address >= value) &&
      (list.length > 1 || value > BigInt(0xffffffff));
    if (looksLikeLoadAddress) {
      result.set(key, value!);
      continue;
    }
    const sample = list.find(
      (frame) => frame.address !== null && frame.offsetValue !== null,
    );
    result.set(
      key,
      sample && sample.address! >= sample.offsetValue!
        ? sample.address! - sample.offsetValue!
        : null,
    );
  }
  return result;
}

function diagnostics(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(diagnostics);
  const record = object(value);
  if (!record) return [];
  if (Array.isArray(record.crashDiagnostics)) {
    return record.crashDiagnostics
      .map(object)
      .filter((entry): entry is JsonObject => entry !== null);
  }
  if (object(record.callStackTree)) return [record];
  return [];
}

export function isMetricKitPayload(value: unknown): boolean {
  return diagnostics(value).length > 0;
}

function parseDiagnostic(diagnostic: JsonObject): NormalizedCrash {
  const meta = object(diagnostic.diagnosticMetaData) ?? {};
  const tree = object(diagnostic.callStackTree) ?? {};
  const stacks = (Array.isArray(tree.callStacks) ? tree.callStacks : [])
    .map(object)
    .filter((stack): stack is JsonObject => stack !== null);
  const rawThreads = stacks.map((stack) => ({
    crashed: stack.threadAttributed === true,
    frames: (Array.isArray(stack.callStackRootFrames)
      ? stack.callStackRootFrames
      : []
    ).flatMap(flatten),
  }));
  const loads = loadAddresses(rawThreads.flatMap((thread) => thread.frames));

  const images: NormalizedImage[] = [];
  const imageIndex = new Map<string, number>();
  const imageFor = (frame: RawFrame): NormalizedImage => {
    const key = frame.uuid ?? frame.name;
    const existing = imageIndex.get(key);
    if (existing !== undefined) return images[existing]!;
    const base = loads.get(key) ?? null;
    const image: NormalizedImage = {
      index: images.length,
      uuid: frame.uuid,
      name: frame.name,
      // MetricKit reports the device's architecture, not the binary's; the dSYM
      // slice matched by UUID supplies the real one.
      arch: null,
      base: base === null ? null : toHex(base),
      size: null,
      path: null,
      isApp: isAppImage(null, frame.name),
    };
    imageIndex.set(key, image.index);
    images.push(image);
    return image;
  };

  const threads: NormalizedThread[] = rawThreads.map((thread, index) => ({
    index,
    name: null,
    queue: null,
    crashed: thread.crashed,
    frames: thread.frames.map((frame): NormalizedFrame => {
      const image = imageFor(frame);
      const base = image.base ? BigInt(image.base) : null;
      const offset =
        frame.address !== null && base !== null && frame.address >= base
          ? frame.address - base
          : null;
      return {
        imageIndex: image.index,
        imageName: image.name,
        imageOffset: offset === null ? null : toHex(offset),
        address: frame.address === null ? null : toHex(frame.address),
        symbol: null,
        symbolOffset: null,
        sourceFile: null,
        sourceLine: null,
      };
    }),
  }));
  if (!threads.some((thread) => thread.frames.length)) {
    throw new CrashParseError("The MetricKit diagnostic has no call stacks");
  }
  let crashedThread = threads.find((thread) => thread.crashed)?.index ?? null;
  if (crashedThread === null && threads.length === 1) {
    threads[0]!.crashed = true;
    crashedThread = 0;
  }

  const objcReason = object(meta.objectiveCexceptionReason);
  const composedReason = text(objcReason?.composedMessage, 4_000);
  const exceptionName = text(objcReason?.exceptionName, 500);
  const info = [
    exceptionName && composedReason
      ? `*** Terminating app due to uncaught exception '${exceptionName}', reason: '${composedReason}'`
      : null,
    text(meta.virtualMemoryRegionInfo, 4_000),
  ].filter((line): line is string => line !== null);
  const bundleId = text(meta.bundleIdentifier, 500);
  const mainImage = images.find((image) => image.isApp) ?? null;

  return {
    format: "METRICKIT",
    incidentId: null,
    appName: text(meta.appName, 500) ?? mainImage?.name ?? null,
    bundleId,
    appVersion: text(meta.appVersion, 200),
    buildVersion: text(meta.appBuildVersion, 200),
    osVersion: text(meta.osVersion, 200),
    deviceModel: text(meta.deviceType, 200),
    arch: text(meta.platformArchitecture, 100),
    processName: mainImage?.name ?? null,
    processPath: null,
    crashedAt:
      appleDate(diagnostic.timeStamp) ??
      appleDate(diagnostic.timeStampEnd) ??
      null,
    exceptionType: machExceptionName(meta.exceptionType),
    exceptionCodes:
      meta.exceptionCode === undefined
        ? null
        : text(String(meta.exceptionCode), 500),
    signal: signalName(meta.signal),
    exceptionSubtype: null,
    exceptionReason: composedReason,
    terminationReason: text(meta.terminationReason, 1_000),
    applicationSpecificInformation: info,
    crashedThread,
    threads,
    lastExceptionBacktrace: null,
    images,
  };
}

export function parseMetricKit(value: unknown): NormalizedCrash[] {
  const found = diagnostics(value);
  if (!found.length) {
    throw new CrashParseError("The JSON holds no MetricKit crash diagnostics");
  }
  const timestamps = object(value);
  return found.map((diagnostic) => {
    const parsed = parseDiagnostic(diagnostic);
    if (!parsed.crashedAt && timestamps) {
      parsed.crashedAt =
        appleDate(timestamps.timeStampEnd) ??
        appleDate(timestamps.timeStampBegin);
    }
    return parsed;
  });
}
