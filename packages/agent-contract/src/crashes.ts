/**
 * Symbolicating iOS crash reports on a macOS agent.
 *
 * The control plane does everything that works on any operating system: it
 * parses the crash, indexes the dSYMs, and decides which image offsets need a
 * name. The agent only runs `atos`, which needs Xcode, and hands the answers
 * back. Parsing the `atos` output lives here rather than in the agent so the
 * app's test suite runs it — `vitest.config.mts` excludes
 * `packages/control-agent/**` but not this package.
 */

export const CRASH_SYMBOLICATE_JOB_KIND = "ios.crash.symbolicate";
export const CRASH_JOB_KINDS = [CRASH_SYMBOLICATE_JOB_KIND] as const;

/** How long one symbolication job may run on the agent. */
export const CRASH_SYMBOLICATION_TIMEOUT_SECONDS = 300;
/** Offsets handed to one `atos` invocation. */
export const ATOS_BATCH_SIZE = 500;
/**
 * Printed by `atos -d` after every address. Inlined frames are separated by
 * newlines, so a line holding only this marker ends one address's answer.
 */
export const ATOS_GROUP_DELIMITER = "<|aide-atos|>";

const MAX_LOOKUPS = 200;
const MAX_OFFSETS = 10_000;

/** One DWARF file the agent downloads before symbolicating. */
export type CrashSymbolicationDsym = {
  dsymId: string;
  /** Checksum of the DWARF Mach-O file, which is also its cache key. */
  sha256: string;
  sizeBytes: number;
  /** Name of the binary inside `Contents/Resources/DWARF`. */
  binaryName: string;
  /** Agent route that serves the DWARF file, relative to the server. */
  downloadPath: string;
};

/** The offsets of one binary image that still need names. */
export type CrashSymbolicationLookup = {
  dsymId: string;
  /** Image UUID: uppercase hexadecimal without dashes. */
  uuid: string;
  /** Slice passed to `atos -arch`. */
  arch: string;
  /** Offsets from the image's load address, as `0x` hexadecimal. */
  offsets: string[];
};

export type CrashSymbolicationPayload = {
  crashId: string;
  dsyms: CrashSymbolicationDsym[];
  lookups: CrashSymbolicationLookup[];
};

/** One function `atos` resolved an address to. */
export type SymbolicatedFrame = {
  symbol: string;
  image: string | null;
  file: string | null;
  line: number | null;
  /** Bytes past the start of the symbol, when there was no line table. */
  symbolOffset: number | null;
};

export type CrashSymbolicationOffsetResult = {
  offset: string;
  /**
   * Innermost first. Every frame but the last was inlined into the one after
   * it. Empty when `atos` could not name the address.
   */
  frames: SymbolicatedFrame[];
};

export type CrashSymbolicationLookupResult = {
  dsymId: string;
  uuid: string;
  results: CrashSymbolicationOffsetResult[];
  /** Why this image produced no results, such as a missing slice. */
  error: string | null;
};

export type CrashSymbolicationResult = {
  lookups: CrashSymbolicationLookupResult[];
  xcodeVersion: string | null;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(
      `${name} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null || value === undefined
    ? null
    : stringValue(value, name, 20_000);
}

function arrayValue(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > maximum) {
    throw new Error(`${name} may hold at most ${maximum} entries`);
  }
  return value;
}

function hexOffset(value: unknown, name: string): string {
  const text = stringValue(value, name, 32);
  if (!/^0x[0-9a-f]+$/i.test(text)) {
    throw new Error(`${name} must be a 0x hexadecimal offset`);
  }
  return `0x${text.slice(2).toLowerCase()}`;
}

/** Uppercase hexadecimal without dashes, the form UUIDs are stored in. */
export function normalizeUuid(value: string): string {
  const compact = value.replaceAll("-", "").replace(/^<|>$/g, "").trim();
  if (!/^[0-9a-f]{32}$/i.test(compact)) {
    throw new Error(`${value} is not a binary image UUID`);
  }
  return compact.toUpperCase();
}

/** The dashed 8-4-4-4-12 form Xcode prints. */
export function formatUuid(value: string): string {
  const compact = normalizeUuid(value);
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function safeFileName(value: unknown, name: string): string {
  const text = stringValue(value, name, 255);
  if (text.includes("/") || text.includes("\\") || text === "..") {
    throw new Error(`${name} must be a plain file name`);
  }
  return text;
}

export function parseCrashSymbolicationPayload(
  value: unknown,
): CrashSymbolicationPayload {
  const payload = objectValue(value, "crash symbolication payload");
  const dsyms = arrayValue(payload.dsyms, "dsyms", MAX_LOOKUPS).map(
    (entry, index): CrashSymbolicationDsym => {
      const dsym = objectValue(entry, `dsyms[${index}]`);
      const sha256 = stringValue(dsym.sha256, `dsyms[${index}].sha256`, 64);
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error(`dsyms[${index}].sha256 must be a sha256 digest`);
      }
      const size = dsym.sizeBytes;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
        throw new Error(`dsyms[${index}].sizeBytes must be a positive integer`);
      }
      const downloadPath = stringValue(
        dsym.downloadPath,
        `dsyms[${index}].downloadPath`,
      );
      if (!downloadPath.startsWith("/api/agent/dsyms/")) {
        throw new Error(`dsyms[${index}].downloadPath is not an agent route`);
      }
      return {
        dsymId: stringValue(dsym.dsymId, `dsyms[${index}].dsymId`, 200),
        sha256,
        sizeBytes: size,
        binaryName: safeFileName(dsym.binaryName, `dsyms[${index}].binaryName`),
        downloadPath,
      };
    },
  );
  const known = new Set(dsyms.map((dsym) => dsym.dsymId));
  let offsetCount = 0;
  const lookups = arrayValue(payload.lookups, "lookups", MAX_LOOKUPS).map(
    (entry, index): CrashSymbolicationLookup => {
      const lookup = objectValue(entry, `lookups[${index}]`);
      const dsymId = stringValue(lookup.dsymId, `lookups[${index}].dsymId`);
      if (!known.has(dsymId)) {
        throw new Error(`lookups[${index}].dsymId is not listed in dsyms`);
      }
      const arch = stringValue(lookup.arch, `lookups[${index}].arch`, 32);
      if (!/^[a-z0-9_]+$/i.test(arch)) {
        throw new Error(`lookups[${index}].arch is invalid`);
      }
      const offsets = arrayValue(
        lookup.offsets,
        `lookups[${index}].offsets`,
        MAX_OFFSETS,
      ).map((offset, position) =>
        hexOffset(offset, `lookups[${index}].offsets[${position}]`),
      );
      offsetCount += offsets.length;
      if (offsetCount > MAX_OFFSETS) {
        throw new Error(`A crash may request at most ${MAX_OFFSETS} offsets`);
      }
      return {
        dsymId,
        uuid: normalizeUuid(
          stringValue(lookup.uuid, `lookups[${index}].uuid`, 64),
        ),
        arch,
        offsets,
      };
    },
  );
  return {
    crashId: stringValue(payload.crashId, "crashId", 200),
    dsyms,
    lookups,
  };
}

function parseFrame(value: unknown, name: string): SymbolicatedFrame {
  const frame = objectValue(value, name);
  const line = frame.line;
  const symbolOffset = frame.symbolOffset;
  const optionalInteger = (entry: unknown, label: string) => {
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)
      throw new Error(`${label} must be a non-negative integer`);
    return entry;
  };
  return {
    symbol: stringValue(frame.symbol, `${name}.symbol`, 20_000),
    image: nullableString(frame.image, `${name}.image`),
    file: nullableString(frame.file, `${name}.file`),
    line: optionalInteger(line, `${name}.line`),
    symbolOffset: optionalInteger(symbolOffset, `${name}.symbolOffset`),
  };
}

/** Validates what an agent reported before the server stores it. */
export function parseCrashSymbolicationResult(
  value: unknown,
): CrashSymbolicationResult {
  const result = objectValue(value, "crash symbolication result");
  return {
    lookups: arrayValue(result.lookups, "lookups", MAX_LOOKUPS).map(
      (entry, index): CrashSymbolicationLookupResult => {
        const lookup = objectValue(entry, `lookups[${index}]`);
        return {
          dsymId: stringValue(lookup.dsymId, `lookups[${index}].dsymId`),
          uuid: normalizeUuid(
            stringValue(lookup.uuid, `lookups[${index}].uuid`, 64),
          ),
          results: arrayValue(
            lookup.results,
            `lookups[${index}].results`,
            MAX_OFFSETS,
          ).map((item, position) => {
            const name = `lookups[${index}].results[${position}]`;
            const offsetResult = objectValue(item, name);
            return {
              offset: hexOffset(offsetResult.offset, `${name}.offset`),
              frames: arrayValue(offsetResult.frames, `${name}.frames`, 64).map(
                (frame, depth) => parseFrame(frame, `${name}.frames[${depth}]`),
              ),
            };
          }),
          error: nullableString(lookup.error, `lookups[${index}].error`),
        };
      },
    ),
    xcodeVersion: nullableString(result.xcodeVersion, "xcodeVersion"),
  };
}

/**
 * The arguments for one `atos` batch. `--offset` makes `atos` add the image's
 * own `__TEXT` address, so the crash's image offsets go in unchanged, and `-i`
 * lists inlined frames innermost first.
 */
export function atosArguments(input: {
  arch: string;
  dwarfPath: string;
  offsetsFile: string;
}): string[] {
  return [
    "atos",
    "-arch",
    input.arch,
    "-o",
    input.dwarfPath,
    "--offset",
    "-i",
    "--fullPath",
    "-d",
    ATOS_GROUP_DELIMITER,
    "-f",
    input.offsetsFile,
  ];
}

/** `symbol (in Image) (File.swift:42)` or `symbol (in Image) + 12`. */
const ATOS_LINE = /^(.+?) \(in ([^)]+)\)(?: \((.+):(\d+)\))?(?: \+ (\d+))?$/;

/**
 * Reads one line of `atos` output. Returns null when `atos` echoed the address
 * back, which is how it reports that it could not name it.
 */
export function parseAtosLine(line: string): SymbolicatedFrame | null {
  const text = line.trim();
  if (!text || /^0x[0-9a-f]+$/i.test(text)) return null;
  const match = ATOS_LINE.exec(text);
  if (!match) {
    return {
      symbol: text,
      image: null,
      file: null,
      line: null,
      symbolOffset: null,
    };
  }
  const [, symbol, image, file, lineNumber, offset] = match;
  return {
    symbol: symbol!,
    image: image ?? null,
    file: file ?? null,
    line: lineNumber ? Number(lineNumber) : null,
    symbolOffset: offset ? Number(offset) : null,
  };
}

/**
 * Splits one `atos` batch into an answer per requested offset. `atos` prints
 * the frames for an address, then the delimiter on its own line.
 */
export function parseAtosOutput(
  stdout: string,
  offsets: string[],
): CrashSymbolicationOffsetResult[] {
  const groups: string[][] = [[]];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === ATOS_GROUP_DELIMITER) groups.push([]);
    else if (line.trim()) groups[groups.length - 1]!.push(line);
  }
  if (!groups[groups.length - 1]!.length) groups.pop();
  if (groups.length !== offsets.length) {
    throw new Error(
      `atos answered ${groups.length} addresses but ${offsets.length} were requested`,
    );
  }
  return offsets.map((offset, index) => ({
    offset,
    frames: groups[index]!.map(parseAtosLine).filter(
      (frame): frame is SymbolicatedFrame => frame !== null,
    ),
  }));
}
