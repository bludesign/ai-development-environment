import type { SymbolicatedFrame } from "@ai-development-environment/agent-contract/crashes";

export const CRASH_REPORT_FORMATS = ["IPS", "CRASH", "METRICKIT"] as const;
export type CrashReportFormat = (typeof CRASH_REPORT_FORMATS)[number];

export const CRASH_REPORT_SOURCES = ["UPLOAD", "API"] as const;
export type CrashReportSource = (typeof CRASH_REPORT_SOURCES)[number];

export const CRASH_REPORT_STATUSES = [
  "PENDING",
  "WAITING_FOR_AGENT",
  "SYMBOLICATING",
  "SYMBOLICATED",
  "PARTIALLY_SYMBOLICATED",
  "MISSING_DSYMS",
  "FAILED",
] as const;
export type CrashReportStatus = (typeof CRASH_REPORT_STATUSES)[number];

/** States the runtime still has work to do for. */
export const ACTIVE_CRASH_STATUSES: readonly CrashReportStatus[] = [
  "PENDING",
  "WAITING_FOR_AGENT",
  "SYMBOLICATING",
];

export const DSYM_SOURCES = ["UPLOAD", "API", "BUILD"] as const;
export type DsymSource = (typeof DSYM_SOURCES)[number];

export const DSYM_UPLOAD_STATUSES = [
  "UPLOADING",
  "PENDING_TRANSFER",
  "PROCESSING",
  "READY",
  "FAILED",
] as const;
export type DsymUploadStatus = (typeof DSYM_UPLOAD_STATUSES)[number];

/**
 * A binary loaded by the crashed process. Addresses are `0x` hexadecimal
 * strings: 64-bit values do not survive a round trip through a double.
 */
export type NormalizedImage = {
  index: number;
  /** Uppercase hexadecimal without dashes, or null when the report omits it. */
  uuid: string | null;
  name: string;
  arch: string | null;
  base: string | null;
  size: number | null;
  path: string | null;
  /**
   * Whether the image ships with the app, so a dSYM the developer uploads can
   * name it. System libraries are symbolicated on the device.
   */
  isApp: boolean;
};

export type NormalizedFrame = {
  imageIndex: number | null;
  imageName: string | null;
  /** Offset from the image's load address. */
  imageOffset: string | null;
  address: string | null;
  symbol: string | null;
  symbolOffset: number | null;
  sourceFile: string | null;
  sourceLine: number | null;
};

export type NormalizedThread = {
  index: number;
  name: string | null;
  queue: string | null;
  crashed: boolean;
  frames: NormalizedFrame[];
};

/** Everything the three input formats have in common. */
export type NormalizedCrash = {
  format: CrashReportFormat;
  incidentId: string | null;
  appName: string | null;
  bundleId: string | null;
  appVersion: string | null;
  buildVersion: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  arch: string | null;
  processName: string | null;
  processPath: string | null;
  /** ISO 8601. */
  crashedAt: string | null;
  exceptionType: string | null;
  exceptionCodes: string | null;
  signal: string | null;
  exceptionSubtype: string | null;
  exceptionReason: string | null;
  terminationReason: string | null;
  applicationSpecificInformation: string[];
  crashedThread: number | null;
  threads: NormalizedThread[];
  lastExceptionBacktrace: NormalizedFrame[] | null;
  images: NormalizedImage[];
};

/**
 * What the agents answered, keyed by image UUID and then by image offset.
 * Stored on the crash so symbols survive the dSYM being deleted.
 */
export type CrashSymbolication = {
  generation: number;
  agentId: string | null;
  xcodeVersion: string | null;
  symbolicatedAt: string | null;
  images: Record<
    string,
    {
      dsymId: string;
      offsets: Record<string, SymbolicatedFrame[]>;
      error: string | null;
    }
  >;
};

export const EMPTY_SYMBOLICATION: CrashSymbolication = {
  generation: 0,
  agentId: null,
  xcodeVersion: null,
  symbolicatedAt: null,
  images: {},
};

/** A frame as the detail page shows it, after symbolication. */
export type DisplayFrame = {
  index: number;
  imageName: string | null;
  imageUuid: string | null;
  address: string | null;
  imageOffset: string | null;
  symbol: string | null;
  symbolOffset: number | null;
  sourceFile: string | null;
  sourceLine: number | null;
  /** Inlined into the next frame with the same index. */
  inlined: boolean;
  isAppFrame: boolean;
  /** Named by a dSYM rather than by the device. */
  symbolicated: boolean;
};

export type DisplayThread = {
  index: number;
  name: string | null;
  queue: string | null;
  crashed: boolean;
  frames: DisplayFrame[];
};

export class CrashParseError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code = "UNPROCESSABLE_CRASH_REPORT",
  ) {
    super(message);
    this.name = "CrashParseError";
  }
}
