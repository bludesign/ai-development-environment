import { createHash } from "node:crypto";

import type {
  CrashSymbolicationResult,
  SymbolicatedFrame,
} from "@ai-development-environment/agent-contract/crashes";

import {
  EMPTY_SYMBOLICATION,
  type CrashReportStatus,
  type CrashSymbolication,
  type DisplayFrame,
  type DisplayThread,
  type NormalizedCrash,
  type NormalizedFrame,
  type NormalizedImage,
} from "./types";

/**
 * Whether a dSYM would add something to a frame: it belongs to the app, and the
 * device either could not name it or named it without a file and line.
 */
function improvable(frame: NormalizedFrame, images: NormalizedImage[]) {
  if (frame.imageIndex === null || frame.imageOffset === null) return false;
  const image = images[frame.imageIndex];
  return Boolean(image?.isApp && image.uuid && !frame.sourceFile);
}

function allFrames(crash: NormalizedCrash): NormalizedFrame[] {
  return [
    ...crash.threads.flatMap((thread) => thread.frames),
    ...(crash.lastExceptionBacktrace ?? []),
  ];
}

/** App images a dSYM could improve, with how many frames each would name. */
export function symbolicationCandidates(
  crash: NormalizedCrash,
): Map<
  number,
  { image: NormalizedImage; offsets: Set<string>; frames: number }
> {
  const candidates = new Map<
    number,
    { image: NormalizedImage; offsets: Set<string>; frames: number }
  >();
  for (const frame of allFrames(crash)) {
    if (!improvable(frame, crash.images)) continue;
    const image = crash.images[frame.imageIndex!]!;
    const entry = candidates.get(image.index) ?? {
      image,
      offsets: new Set<string>(),
      frames: 0,
    };
    entry.offsets.add(frame.imageOffset!);
    entry.frames += 1;
    candidates.set(image.index, entry);
  }
  return candidates;
}

function resolvedFrames(
  frame: NormalizedFrame,
  images: NormalizedImage[],
  symbolication: CrashSymbolication,
): SymbolicatedFrame[] | null {
  if (frame.imageIndex === null || frame.imageOffset === null) return null;
  const uuid = images[frame.imageIndex]?.uuid;
  if (!uuid) return null;
  const frames = symbolication.images[uuid]?.offsets[frame.imageOffset];
  return frames?.length ? frames : null;
}

/**
 * Whether a frame still has no name after symbolication. Frames the device
 * already named count as named even without a file and line.
 */
function unnamed(
  frame: NormalizedFrame,
  images: NormalizedImage[],
  symbolication: CrashSymbolication,
) {
  return (
    improvable(frame, images) &&
    !frame.symbol &&
    !resolvedFrames(frame, images, symbolication)
  );
}

export function displayFrames(
  frames: NormalizedFrame[],
  images: NormalizedImage[],
  symbolication: CrashSymbolication = EMPTY_SYMBOLICATION,
): DisplayFrame[] {
  const result: DisplayFrame[] = [];
  frames.forEach((frame, index) => {
    const image =
      frame.imageIndex === null ? undefined : images[frame.imageIndex];
    const base: DisplayFrame = {
      index,
      imageName: frame.imageName ?? image?.name ?? null,
      imageUuid: image?.uuid ?? null,
      address: frame.address,
      imageOffset: frame.imageOffset,
      symbol: frame.symbol,
      symbolOffset: frame.symbolOffset,
      sourceFile: frame.sourceFile,
      sourceLine: frame.sourceLine,
      inlined: false,
      isAppFrame: Boolean(image?.isApp),
      symbolicated: false,
    };
    const resolved = resolvedFrames(frame, images, symbolication);
    if (!resolved || frame.sourceFile) {
      result.push(base);
      return;
    }
    resolved.forEach((entry, depth) => {
      result.push({
        ...base,
        symbol: entry.symbol,
        symbolOffset: entry.symbolOffset,
        sourceFile: entry.file,
        sourceLine: entry.line,
        inlined: depth < resolved.length - 1,
        symbolicated: true,
      });
    });
  });
  return result;
}

export function displayThreads(
  crash: NormalizedCrash,
  symbolication: CrashSymbolication = EMPTY_SYMBOLICATION,
): DisplayThread[] {
  return crash.threads.map((thread) => ({
    index: thread.index,
    name: thread.name,
    queue: thread.queue,
    crashed: thread.crashed,
    frames: displayFrames(thread.frames, crash.images, symbolication),
  }));
}

/** Stores what an agent reported under the UUIDs and offsets it answered. */
export function mergeSymbolication(
  existing: CrashSymbolication,
  result: CrashSymbolicationResult,
  context: { generation: number; agentId: string | null; at: Date },
): CrashSymbolication {
  const images = { ...existing.images };
  for (const lookup of result.lookups) {
    const offsets: Record<string, SymbolicatedFrame[]> = {
      ...(images[lookup.uuid]?.offsets ?? {}),
    };
    for (const entry of lookup.results) {
      if (entry.frames.length) offsets[entry.offset] = entry.frames;
    }
    images[lookup.uuid] = {
      dsymId: lookup.dsymId,
      offsets,
      error: lookup.error,
    };
  }
  return {
    generation: context.generation,
    agentId: context.agentId,
    xcodeVersion: result.xcodeVersion,
    symbolicatedAt: context.at.toISOString(),
    images,
  };
}

/**
 * The state a crash settles in once there is nothing left to ask an agent.
 * `matched` holds the UUIDs of images a dSYM was available for.
 */
export function settledStatus(
  crash: NormalizedCrash,
  symbolication: CrashSymbolication,
  matched: ReadonlySet<string>,
): { status: CrashReportStatus; message: string | null } {
  const candidates = [...symbolicationCandidates(crash).values()];
  const stillUnnamed = allFrames(crash).filter((frame) =>
    unnamed(frame, crash.images, symbolication),
  );
  if (!stillUnnamed.length) return { status: "SYMBOLICATED", message: null };
  const named = allFrames(crash).some((frame) =>
    Boolean(resolvedFrames(frame, crash.images, symbolication)),
  );
  const errors = candidates
    .map(({ image }) =>
      image.uuid ? symbolication.images[image.uuid]?.error : null,
    )
    .filter((error): error is string => Boolean(error));
  const missing = candidates.filter(
    ({ image }) => image.uuid && !matched.has(image.uuid),
  );
  if (errors.length && !named) {
    return { status: "FAILED", message: errors.join("; ").slice(0, 2_000) };
  }
  if (named) {
    return {
      status: "PARTIALLY_SYMBOLICATED",
      message: missing.length
        ? `Missing dSYMs for ${missing.map(({ image }) => image.name).join(", ")}`
        : errors.join("; ").slice(0, 2_000) || null,
    };
  }
  return {
    status: "MISSING_DSYMS",
    message: missing.length
      ? `Missing dSYMs for ${missing.map(({ image }) => image.name).join(", ")}`
      : null,
  };
}

function frameLabel(frame: DisplayFrame): string {
  if (frame.symbol) return frame.symbol;
  return `${frame.imageName ?? "???"}+${frame.imageOffset ?? frame.address ?? "?"}`;
}

/**
 * Groups crashes that failed the same way: the exception plus the first three
 * app frames of the crashed thread. Offsets change with every build, so the
 * signature is only stable across builds once the frames have names.
 */
export function crashSignature(
  crash: NormalizedCrash,
  symbolication: CrashSymbolication = EMPTY_SYMBOLICATION,
): { signature: string; title: string } {
  const crashed =
    crash.threads.find((thread) => thread.crashed) ?? crash.threads[0];
  const frames = crashed
    ? displayFrames(crashed.frames, crash.images, symbolication).filter(
        (frame) => !frame.inlined,
      )
    : [];
  const appFrames = frames.filter((frame) => frame.isAppFrame);
  const chosen = (appFrames.length ? appFrames : frames).slice(0, 3);
  const exception = crash.exceptionType ?? crash.signal ?? "Crash";
  const parts = [
    exception,
    crash.exceptionReason ? crash.exceptionReason.slice(0, 200) : "",
    ...chosen.map(frameLabel),
  ];
  const signature = createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex")
    .slice(0, 24);
  const lead = chosen[0] ? frameLabel(chosen[0]) : null;
  return {
    signature,
    title: [exception, lead].filter(Boolean).join(" · ").slice(0, 500),
  };
}

function pad(value: string, width: number) {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

function hexAddress(value: string | null): string {
  if (!value) return "0x0000000000000000";
  return `0x${value.slice(2).padStart(16, "0")}`;
}

function frameLine(frame: DisplayFrame): string {
  const location = frame.symbol
    ? [
        frame.symbol,
        frame.symbolOffset !== null && !frame.inlined
          ? ` + ${frame.symbolOffset}`
          : "",
        frame.sourceFile
          ? ` (${frame.sourceFile.split("/").pop()}:${frame.sourceLine ?? 0})`
          : "",
        frame.inlined ? " [inlined]" : "",
      ].join("")
    : frame.imageOffset && frame.address
      ? `0x${(BigInt(frame.address) - BigInt(frame.imageOffset)).toString(16)} + ${BigInt(frame.imageOffset).toString()}`
      : "???";
  return `${pad(String(frame.index), 4)}${pad(frame.imageName ?? "???", 30)}\t${hexAddress(frame.address)} ${location}`;
}

/**
 * Renders the crash in Apple's text format with every symbol the dSYMs added,
 * the same shape Xcode's Organizer exports, whatever format came in.
 */
export function renderCrashText(
  crash: NormalizedCrash,
  symbolication: CrashSymbolication = EMPTY_SYMBOLICATION,
): string {
  const lines: string[] = [];
  const field = (name: string, value: string | null | undefined) => {
    if (value) lines.push(`${pad(`${name}:`, 21)}${value}`);
  };
  field("Incident Identifier", crash.incidentId);
  field("Hardware Model", crash.deviceModel);
  field("Process", crash.processName ?? crash.appName);
  field("Path", crash.processPath);
  field("Identifier", crash.bundleId);
  field(
    "Version",
    crash.appVersion
      ? `${crash.appVersion}${crash.buildVersion ? ` (${crash.buildVersion})` : ""}`
      : crash.buildVersion,
  );
  field("Code Type", crash.arch);
  lines.push("");
  field("Date/Time", crash.crashedAt);
  field("OS Version", crash.osVersion);
  lines.push("");
  if (crash.exceptionType) {
    lines.push(
      `Exception Type:  ${crash.exceptionType}${crash.signal ? ` (${crash.signal})` : ""}`,
    );
  }
  if (crash.exceptionCodes)
    lines.push(`Exception Codes: ${crash.exceptionCodes}`);
  if (crash.exceptionSubtype)
    lines.push(`Exception Subtype: ${crash.exceptionSubtype}`);
  if (crash.terminationReason)
    lines.push(`Termination Reason: ${crash.terminationReason}`);
  lines.push("");
  if (crash.crashedThread !== null) {
    lines.push(`Triggered by Thread:  ${crash.crashedThread}`, "");
  }
  if (crash.applicationSpecificInformation.length) {
    lines.push(
      "Application Specific Information:",
      ...crash.applicationSpecificInformation,
      "",
    );
  }
  if (crash.lastExceptionBacktrace?.length) {
    lines.push("Last Exception Backtrace:");
    for (const frame of displayFrames(
      crash.lastExceptionBacktrace,
      crash.images,
      symbolication,
    )) {
      lines.push(frameLine(frame));
    }
    lines.push("");
  }
  for (const thread of displayThreads(crash, symbolication)) {
    const label = thread.name ?? thread.queue;
    if (label) {
      lines.push(
        `Thread ${thread.index} name:   ${thread.queue && !thread.name ? `Dispatch queue: ${thread.queue}` : label}`,
      );
    }
    lines.push(`Thread ${thread.index}${thread.crashed ? " Crashed" : ""}:`);
    for (const frame of thread.frames) lines.push(frameLine(frame));
    lines.push("");
  }
  const images = crash.images.filter((image) => image.base && image.uuid);
  if (images.length) {
    lines.push("Binary Images:");
    for (const image of images) {
      const base = BigInt(image.base!);
      const end =
        image.size !== null && image.size > 0
          ? `0x${(base + BigInt(image.size) - BigInt(1)).toString(16)}`
          : "???";
      lines.push(
        `${`0x${base.toString(16)}`.padStart(18)} - ${end.padStart(18)} ${image.name} ${image.arch ?? ""}  <${image.uuid!.toLowerCase()}> ${image.path ?? ""}`.trimEnd(),
      );
    }
    lines.push("");
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
