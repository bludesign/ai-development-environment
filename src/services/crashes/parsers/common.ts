import { normalizeUuid } from "@ai-development-environment/agent-contract/crashes";

/** Paths that belong to the operating system rather than the app bundle. */
const SYSTEM_PATH_PREFIXES = [
  "/System/",
  "/usr/lib/",
  "/usr/libexec/",
  "/Developer/",
  "/Library/Apple/",
  "/private/preboot/",
  "/Applications/Xcode",
  "/Library/Developer/CoreSimulator/",
];

/**
 * Names MetricKit reports for system binaries. MetricKit sends no paths, so a
 * name is all there is to tell the app's own frameworks from the OS's.
 */
const SYSTEM_IMAGE_NAMES =
  /^(?:lib.*\.dylib|dyld|dyld_sim|UIKit(?:Core)?|Foundation|CoreFoundation|SwiftUI(?:Core)?|CFNetwork|GraphicsServices|FrontBoardServices|BackBoardServices|BaseBoard|RunningBoardServices|QuartzCore|CoreGraphics|CoreText|CoreData|CoreAnimation|WebKit|WebCore|JavaScriptCore|Combine|Security|Network|UIFoundation|AttributeGraph|AppKit|Metal|AVFoundation|AVFCore|MediaToolbox|CoreMedia|CoreServices|SpringBoardServices|MetricKit|StoreKit|Observation)$/;

export function isAppImage(path: string | null, name: string): boolean {
  if (path) {
    if (path.includes("/dyld_shared_cache")) return false;
    return !SYSTEM_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  }
  return !SYSTEM_IMAGE_NAMES.test(name);
}

export function toHex(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

export function hexValue(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^0x[0-9a-f]+$/i.test(text)) return BigInt(text);
    if (/^\d+$/.test(text)) return BigInt(text);
  }
  return null;
}

/** Null for a missing, malformed, or all-zero UUID. */
export function optionalUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const uuid = normalizeUuid(value);
    return /^0+$/.test(uuid) ? null : uuid;
  } catch {
    return null;
  }
}

export function text(value: unknown, maximum = 2_000): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

export function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Reads the timestamps crash reports print, such as
 * `2026-09-23 19:54:35.00 -0400` or `2026-09-20 14:21:33.4051 -0700`, and
 * returns ISO 8601. Returns null for anything else rather than guessing a zone.
 */
export function appleDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*([+-]\d{2}):?(\d{2})?$/.exec(
      value.trim(),
    );
  if (match) {
    const [, day, time, fraction = "0", zoneHours, zoneMinutes = "00"] = match;
    const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
    const parsed = new Date(
      `${day}T${time}.${milliseconds}${zoneHours}:${zoneMinutes}`,
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) || !/\d{4}/.test(value)
    ? null
    : fallback.toISOString();
}

const EXCEPTION_TYPES: Record<number, string> = {
  1: "EXC_BAD_ACCESS",
  2: "EXC_BAD_INSTRUCTION",
  3: "EXC_ARITHMETIC",
  4: "EXC_EMULATION",
  5: "EXC_SOFTWARE",
  6: "EXC_BREAKPOINT",
  7: "EXC_SYSCALL",
  8: "EXC_MACH_SYSCALL",
  9: "EXC_RPC_ALERT",
  10: "EXC_CRASH",
  11: "EXC_RESOURCE",
  12: "EXC_GUARD",
  13: "EXC_CORPSE_NOTIFY",
};

const SIGNALS: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGEMT",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGBUS",
  11: "SIGSEGV",
  12: "SIGSYS",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

export function machExceptionName(value: unknown): string | null {
  const number = integer(value);
  if (number !== null) return EXCEPTION_TYPES[number] ?? `EXC_${number}`;
  return text(value, 200);
}

export function signalName(value: unknown): string | null {
  const number = integer(value);
  if (number !== null) return SIGNALS[number] ?? `SIG${number}`;
  return text(value, 200);
}
