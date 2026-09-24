import { describe, expect, test } from "vitest";

import { thinMachO } from "./__fixtures__/macho-builder";
import { archName, MachOError, readMachOSlices } from "./macho";

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

function fat(slices: { cpuType: number; bytes: Buffer }[]): Buffer {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = 0x1000;
  const parts: Buffer[] = [];
  slices.forEach((slice, index) => {
    header.writeInt32BE(slice.cpuType, 8 + index * 20);
    header.writeUInt32BE(offset, 8 + index * 20 + 8);
    header.writeUInt32BE(slice.bytes.length, 8 + index * 20 + 12);
    parts.push(slice.bytes);
    offset += 0x1000;
  });
  const file = Buffer.alloc(offset);
  header.copy(file, 0);
  parts.forEach((part, index) => part.copy(file, 0x1000 * (index + 1)));
  return file;
}

function reader(buffer: Buffer) {
  return async (position: number, length: number) =>
    buffer.subarray(position, position + length);
}

describe("Mach-O reader", () => {
  test("reads a thin slice's UUID, arch, and __TEXT address", async () => {
    const file = thinMachO({
      uuid: "776386d0-4386-3f24-9b21-5f7c02eb2873",
      cpuSubtype: 2,
    });
    await expect(readMachOSlices(reader(file), file.length)).resolves.toEqual([
      {
        uuid: "776386D043863F249B215F7C02EB2873",
        arch: "arm64e",
        textVmAddr: "0x100000000",
      },
    ]);
  });

  test("reads every slice of a universal binary", async () => {
    const file = fat([
      {
        cpuType: ARM64,
        bytes: thinMachO({ uuid: "11111111111111111111111111111111" }),
      },
      {
        cpuType: X86_64,
        bytes: thinMachO({
          uuid: "22222222222222222222222222222222",
          cpuType: X86_64,
          cpuSubtype: 3,
          textVmAddr: BigInt(0),
        }),
      },
    ]);
    const slices = await readMachOSlices(reader(file), file.length);
    expect(slices.map((slice) => [slice.arch, slice.textVmAddr])).toEqual([
      ["arm64", "0x100000000"],
      ["x86_64", "0x0"],
    ]);
  });

  test("rejects files that are not Mach-O or have no UUID", async () => {
    const text = Buffer.from("not a binary at all, just some text here");
    await expect(readMachOSlices(reader(text), text.length)).rejects.toThrow(
      MachOError,
    );
    const noUuid = thinMachO({ uuid: "11111111111111111111111111111111" });
    noUuid.writeUInt32LE(1, 16);
    await expect(
      readMachOSlices(reader(noUuid), noUuid.length),
    ).rejects.toThrow("no LC_UUID");
  });

  test("names architectures the way atos expects them", () => {
    expect(archName(ARM64, 0)).toBe("arm64");
    expect(archName(ARM64, 2 | 0x80000000)).toBe("arm64e");
    expect(archName(0x0200000c, 1)).toBe("arm64_32");
    expect(archName(12, 11)).toBe("armv7s");
    expect(archName(X86_64, 8)).toBe("x86_64h");
  });
});
