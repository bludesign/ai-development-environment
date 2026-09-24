/**
 * Builds small Mach-O files for tests, so the reader and indexer can be checked
 * without Xcode or a checked-in binary for every case.
 */

const ARM64 = 0x0100000c;

/** A minimal 64-bit Mach-O: header, `__TEXT` segment, and `LC_UUID`. */
export function thinMachO(input: {
  uuid: string;
  cpuType?: number;
  cpuSubtype?: number;
  textVmAddr?: bigint;
}): Buffer {
  const segment = Buffer.alloc(72);
  segment.writeUInt32LE(0x19, 0);
  segment.writeUInt32LE(72, 4);
  segment.write("__TEXT", 8, "ascii");
  segment.writeBigUInt64LE(input.textVmAddr ?? BigInt(0x100000000), 24);
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  Buffer.from(input.uuid.replaceAll("-", ""), "hex").copy(uuid, 8);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeInt32LE(input.cpuType ?? ARM64, 4);
  header.writeInt32LE(input.cpuSubtype ?? 0, 8);
  header.writeUInt32LE(0xa, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(segment.length + uuid.length, 20);
  return Buffer.concat([header, segment, uuid, Buffer.alloc(64)]);
}
