// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { zipSync, type Zippable } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { thinMachO } from "./__fixtures__/macho-builder";
import { DsymIndexError, extractDsymArchive } from "./dsym-index";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dsym-index-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function zipFile(name: string, files: Zippable): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, zipSync(files));
  return path;
}

async function index(zipPath: string, archiveName = "dSYMs.zip") {
  return extractDsymArchive({
    zipPath,
    archiveName,
    destination: join(directory, "out"),
  });
}

const plist = (identifier: string) =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.apple.xcode.dsym.${identifier}</string><key>CFBundleShortVersionString</key><string>2.4.0</string><key>CFBundleVersion</key><string>512</string></dict></plist>`,
  );

describe("dSYM indexer", () => {
  test("indexes the checked-in dSYM zip", async () => {
    const [dsym] = await index(
      resolve(__dirname, "__fixtures__/CrashDemo.dSYM.zip"),
    );
    expect(dsym).toMatchObject({
      bundleName: "CrashDemo.dSYM",
      binaryName: "CrashDemo",
      bundleIdentifier: "CrashDemo",
      slices: [
        {
          uuid: "776386D043863F249B215F7C02EB2873",
          arch: "arm64",
          textVmAddr: "0x100000000",
        },
      ],
    });
    const extracted = await readFile(join(directory, "out", dsym!.dwarfPath));
    expect(extracted.length).toBe(dsym!.dwarfSizeBytes);
    expect(dsym!.dwarfPath).toMatch(
      /^[0-9a-f-]{36}\/CrashDemo\.dSYM\/Contents\/Resources\/DWARF\/CrashDemo$/,
    );
  });

  test("finds every bundle of an archive's dSYMs folder and skips resource forks", async () => {
    const zip = await zipFile("archive.zip", {
      "App.xcarchive/dSYMs/App.app.dSYM/Contents/Info.plist":
        plist("com.example.app"),
      "App.xcarchive/dSYMs/App.app.dSYM/Contents/Resources/DWARF/App":
        thinMachO({ uuid: "11111111111111111111111111111111" }),
      "App.xcarchive/dSYMs/App.app.dSYM/Contents/Resources/DWARF/._App":
        Buffer.from("resource fork"),
      "App.xcarchive/dSYMs/Widgets.appex.dSYM/Contents/Resources/DWARF/Widgets":
        thinMachO({ uuid: "22222222222222222222222222222222" }),
      "__MACOSX/App.xcarchive/._dSYMs": Buffer.from("x"),
      "App.xcarchive/Info.plist": Buffer.from("<plist/>"),
    });
    const dsyms = await index(zip);
    expect(
      dsyms.map((dsym) => [
        dsym.bundleName,
        dsym.bundleIdentifier,
        dsym.shortVersion,
        dsym.bundleVersion,
      ]),
    ).toEqual([
      ["App.app.dSYM", "com.example.app", "2.4.0", "512"],
      ["Widgets.appex.dSYM", null, null, null],
    ]);
  });

  test("accepts a zip of a bundle's contents", async () => {
    const zip = await zipFile("Acme.app.dSYM.zip", {
      "Contents/Resources/DWARF/Acme": thinMachO({
        uuid: "33333333333333333333333333333333",
      }),
    });
    const [dsym] = await index(zip, "Acme.app.dSYM.zip");
    expect(dsym!.bundleName).toBe("Acme.app.dSYM");
  });

  test("rejects zips without dSYMs, with links, or escaping their folder", async () => {
    await expect(
      index(await zipFile("empty.zip", { "readme.txt": Buffer.from("hi") })),
    ).rejects.toThrow("holds no dSYM bundles");

    const linked = await zipFile("linked.zip", {
      "App.app.dSYM/Contents/Resources/DWARF/App": [
        Buffer.from("/etc/passwd"),
        { os: 3, attrs: (0o120777 << 16) >>> 0 },
      ],
    });
    await expect(index(linked)).rejects.toThrow("symbolic link");

    const escaping = await zipFile("escaping.zip", {
      "../App.app.dSYM/Contents/Resources/DWARF/App": thinMachO({
        uuid: "44444444444444444444444444444444",
      }),
    });
    await expect(index(escaping)).rejects.toThrow(DsymIndexError);

    await writeFile(join(directory, "garbage.zip"), "not a zip");
    await expect(index(join(directory, "garbage.zip"))).rejects.toThrow(
      "not a readable zip",
    );
  });

  test("reports DWARF files that are not Mach-O", async () => {
    const zip = await zipFile("broken.zip", {
      "App.app.dSYM/Contents/Resources/DWARF/App": Buffer.from(
        "definitely not a binary file of any kind",
      ),
    });
    await expect(index(zip)).rejects.toThrow("None of the dSYMs could be read");
  });
});
