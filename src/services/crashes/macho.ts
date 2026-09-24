import { normalizeUuid } from "@ai-development-environment/agent-contract/crashes";

/**
 * Reads what a crash needs from a dSYM's DWARF file without Xcode: each slice's
 * UUID, architecture, and `__TEXT` address. Only headers and load commands are
 * read, so a multi-gigabyte DWARF file costs a few kilobytes.
 */

export type MachOSlice = {
  uuid: string;
  arch: string;
  /** `__TEXT` segment address, `0x` hexadecimal. */
  textVmAddr: string;
};

/** Reads `length` bytes at `position`; may return fewer at end of file. */
export type ByteReader = (
  position: number,
  length: number,
) => Promise<Uint8Array>;

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const CPU_ARCH_ABI64 = 0x01000000;
const CPU_ARCH_ABI64_32 = 0x02000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_SUBTYPE_MASK = 0x00ffffff;
/** Upper bound on load commands read per slice, far above what dSYMs use. */
const MAX_LOAD_COMMANDS_BYTES = 16 * 1024 * 1024;
const MAX_FAT_SLICES = 32;

export class MachOError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachOError";
  }
}

export function archName(cpuType: number, cpuSubtype: number): string {
  const subtype = cpuSubtype & CPU_SUBTYPE_MASK;
  if (cpuType === (CPU_TYPE_ARM | CPU_ARCH_ABI64)) {
    return subtype === 2 ? "arm64e" : "arm64";
  }
  if (cpuType === (CPU_TYPE_ARM | CPU_ARCH_ABI64_32)) return "arm64_32";
  if (cpuType === CPU_TYPE_ARM) {
    return (
      { 9: "armv7", 11: "armv7s", 12: "armv7k" }[subtype] ?? `arm-${subtype}`
    );
  }
  if (cpuType === (CPU_TYPE_X86 | CPU_ARCH_ABI64)) {
    return subtype === 8 ? "x86_64h" : "x86_64";
  }
  if (cpuType === CPU_TYPE_X86) return "i386";
  return `cpu-${cpuType}-${subtype}`;
}

async function exactly(
  read: ByteReader,
  position: number,
  length: number,
): Promise<DataView> {
  const bytes = await read(position, length);
  if (bytes.byteLength < length) {
    throw new MachOError("The Mach-O file ends inside a header");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, length);
}

function segmentName(view: DataView, offset: number): string {
  let name = "";
  for (let index = 0; index < 16; index += 1) {
    const code = view.getUint8(offset + index);
    if (!code) break;
    name += String.fromCharCode(code);
  }
  return name;
}

function uuidAt(view: DataView, offset: number): string {
  let hex = "";
  for (let index = 0; index < 16; index += 1) {
    hex += view
      .getUint8(offset + index)
      .toString(16)
      .padStart(2, "0");
  }
  return normalizeUuid(hex);
}

async function readSlice(
  read: ByteReader,
  offset: number,
  size: number,
): Promise<MachOSlice> {
  const header = await exactly(read, offset, 28);
  const magic = header.getUint32(0, true);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
    throw new MachOError("The file is not a little-endian Mach-O binary");
  }
  const is64 = magic === MH_MAGIC_64;
  const cpuType = header.getInt32(4, true);
  const cpuSubtype = header.getInt32(8, true);
  const commandCount = header.getUint32(16, true);
  const commandsSize = header.getUint32(20, true);
  const headerSize = is64 ? 32 : 28;
  if (
    commandsSize > MAX_LOAD_COMMANDS_BYTES ||
    headerSize + commandsSize > size
  ) {
    throw new MachOError("The Mach-O load commands are out of bounds");
  }
  const commands = await exactly(read, offset + headerSize, commandsSize);
  let cursor = 0;
  let uuid: string | null = null;
  let textVmAddr: bigint | null = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandsSize) break;
    const command = commands.getUint32(cursor, true);
    const commandSize = commands.getUint32(cursor + 4, true);
    if (commandSize < 8 || cursor + commandSize > commandsSize) {
      throw new MachOError("A Mach-O load command is malformed");
    }
    if (command === LC_UUID && commandSize >= 24) {
      uuid = uuidAt(commands, cursor + 8);
    } else if (
      command === LC_SEGMENT_64 &&
      commandSize >= 40 &&
      segmentName(commands, cursor + 8) === "__TEXT"
    ) {
      textVmAddr = commands.getBigUint64(cursor + 24, true);
    } else if (
      command === LC_SEGMENT &&
      commandSize >= 32 &&
      segmentName(commands, cursor + 8) === "__TEXT"
    ) {
      textVmAddr = BigInt(commands.getUint32(cursor + 24, true));
    }
    cursor += commandSize;
  }
  if (!uuid) throw new MachOError("The Mach-O slice has no LC_UUID");
  return {
    uuid,
    arch: archName(cpuType, cpuSubtype),
    textVmAddr: `0x${(textVmAddr ?? BigInt(0)).toString(16)}`,
  };
}

/** Every slice of a thin or universal (fat) Mach-O file. */
export async function readMachOSlices(
  read: ByteReader,
  size: number,
): Promise<MachOSlice[]> {
  if (size < 28) throw new MachOError("The file is too small to be Mach-O");
  const start = await exactly(read, 0, 8);
  const magic = start.getUint32(0, false);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return [await readSlice(read, 0, size)];
  }
  const count = start.getUint32(4, false);
  if (!count || count > MAX_FAT_SLICES) {
    throw new MachOError("The universal binary lists an invalid slice count");
  }
  const entrySize = magic === FAT_MAGIC_64 ? 32 : 20;
  const table = await exactly(read, 8, count * entrySize);
  const slices: MachOSlice[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * entrySize;
    const offset =
      magic === FAT_MAGIC_64
        ? Number(table.getBigUint64(base + 8, false))
        : table.getUint32(base + 8, false);
    const sliceSize =
      magic === FAT_MAGIC_64
        ? Number(table.getBigUint64(base + 16, false))
        : table.getUint32(base + 12, false);
    if (offset + sliceSize > size) {
      throw new MachOError("A universal binary slice runs past the file");
    }
    slices.push(await readSlice(read, offset, sliceSize));
  }
  return slices;
}
