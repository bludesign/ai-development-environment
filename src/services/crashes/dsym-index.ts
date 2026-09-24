import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { parsePlist } from "@ai-development-environment/agent-contract/plist";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { readMachOSlices, type MachOSlice } from "./macho";

/** Most dSYM bundles one upload may hold. An app with extensions has a dozen. */
const MAX_DSYMS = 500;
/** Uncompressed ceiling for one upload, which guards against zip bombs. */
const MAX_EXTRACTED_BYTES = 64 * 1024 ** 3;
const MAX_PLIST_BYTES = 1024 * 1024;

export class DsymIndexError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "DsymIndexError";
  }
}

export type IndexedDsym = {
  id: string;
  bundleName: string;
  binaryName: string;
  bundleIdentifier: string | null;
  shortVersion: string | null;
  bundleVersion: string | null;
  /** Relative to the upload's folder. */
  dwarfPath: string;
  dwarfSha256: string;
  dwarfSizeBytes: number;
  infoPlistPath: string | null;
  slices: MachOSlice[];
};

type BundleEntries = {
  bundleName: string;
  dwarf: Entry[];
  plist: Entry | null;
};

const DWARF_ENTRY =
  /^(?:(.*)\/)?([^/]+\.dSYM)\/Contents\/Resources\/DWARF\/([^/]+)$/i;
const PLIST_ENTRY = /^(?:(.*)\/)?([^/]+\.dSYM)\/Contents\/Info\.plist$/i;
/** A zip of a bundle's contents rather than the bundle itself. */
const BARE_DWARF_ENTRY = /^Contents\/Resources\/DWARF\/([^/]+)$/;
const BARE_PLIST_ENTRY = /^Contents\/Info\.plist$/;

function isSymlink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

function ignored(fileName: string): boolean {
  const name = basename(fileName);
  return (
    fileName.startsWith("__MACOSX/") ||
    name.startsWith("._") ||
    name === ".DS_Store"
  );
}

async function entries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const found: Entry[] = [];
    zip.on("entry", (entry: Entry) => {
      found.push(entry);
      zip.readEntry();
    });
    zip.on("end", () => resolve(found));
    zip.on("error", reject);
    zip.readEntry();
  });
}

function groupBundles(list: Entry[], archiveName: string): BundleEntries[] {
  const bundles = new Map<string, BundleEntries>();
  const bundleFor = (key: string, bundleName: string) => {
    const existing = bundles.get(key);
    if (existing) return existing;
    const created: BundleEntries = { bundleName, dwarf: [], plist: null };
    bundles.set(key, created);
    return created;
  };
  const bareName = archiveName.replace(/\.zip$/i, "") || "Symbols";
  const bareBundle = bareName.endsWith(".dSYM") ? bareName : `${bareName}.dSYM`;
  for (const entry of list) {
    const name = entry.fileName;
    if (name.endsWith("/") || ignored(name)) continue;
    if (isSymlink(entry)) {
      throw new DsymIndexError(
        `The zip holds a symbolic link (${name}); upload the dSYM files themselves`,
      );
    }
    const dwarf = DWARF_ENTRY.exec(name);
    if (dwarf) {
      bundleFor(`${dwarf[1] ?? ""}/${dwarf[2]}`, dwarf[2]!).dwarf.push(entry);
      continue;
    }
    const plist = PLIST_ENTRY.exec(name);
    if (plist) {
      bundleFor(`${plist[1] ?? ""}/${plist[2]}`, plist[2]!).plist = entry;
      continue;
    }
    if (BARE_DWARF_ENTRY.test(name)) {
      bundleFor("", bareBundle).dwarf.push(entry);
    } else if (BARE_PLIST_ENTRY.test(name)) {
      bundleFor("", bareBundle).plist = entry;
    }
  }
  return [...bundles.values()].filter((bundle) => bundle.dwarf.length);
}

async function extract(
  zip: ZipFile,
  entry: Entry,
  destination: string,
): Promise<{ sha256: string; size: number }> {
  const digest = createHash("sha256");
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    await zip.openReadStreamPromise(entry),
    counter,
    createWriteStream(destination, { mode: 0o600 }),
  );
  return { sha256: digest.digest("hex"), size };
}

async function readPlist(
  zip: ZipFile,
  entry: Entry,
): Promise<Record<string, unknown> | null> {
  if (entry.uncompressedSize > MAX_PLIST_BYTES) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of await zip.openReadStreamPromise(entry)) {
    chunks.push(chunk as Buffer);
  }
  try {
    const value = parsePlist(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Binary plists and damaged metadata leave the version columns empty.
    return null;
  }
}

async function slicesOf(path: string, size: number): Promise<MachOSlice[]> {
  const handle = await open(path, "r");
  try {
    return await readMachOSlices(async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    }, size);
  } finally {
    await handle.close();
  }
}

function plistString(
  plist: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = plist?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : null;
}

/**
 * Extracts every dSYM bundle in a zip into `destination` and reads each DWARF
 * file's slices. Only DWARF files and `Info.plist`s are written; resources,
 * relocation maps, and anything else in the zip are skipped. The resulting
 * layout is `<destination>/<dsymId>/<Bundle>.dSYM/Contents/...`, a real dSYM
 * bundle that `atos` and Xcode can open.
 */
export async function extractDsymArchive(input: {
  zipPath: string;
  archiveName: string;
  destination: string;
}): Promise<IndexedDsym[]> {
  let zip: ZipFile;
  try {
    zip = await yauzl.openPromise(input.zipPath, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (error) {
    throw new DsymIndexError(
      `The upload is not a readable zip: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    let list: Entry[];
    try {
      list = await entries(zip);
    } catch (error) {
      throw new DsymIndexError(
        `The zip could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const bundles = groupBundles(list, input.archiveName);
    if (!bundles.length) {
      throw new DsymIndexError(
        "The zip holds no dSYM bundles. Zip the .dSYM folders, for example an archive's dSYMs folder",
      );
    }
    if (bundles.length > MAX_DSYMS) {
      throw new DsymIndexError(
        `One upload may hold at most ${MAX_DSYMS} dSYMs`,
      );
    }
    const total = bundles
      .flatMap((bundle) => bundle.dwarf)
      .reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    if (total > MAX_EXTRACTED_BYTES) {
      throw new DsymIndexError("The zip expands to more than 64 GiB");
    }

    const indexed: IndexedDsym[] = [];
    const failures: string[] = [];
    for (const bundle of bundles) {
      const plist = bundle.plist ? await readPlist(zip, bundle.plist) : null;
      for (const entry of bundle.dwarf) {
        const id = randomUUID();
        const binaryName = basename(entry.fileName);
        const relativeBundle = `${id}/${bundle.bundleName}`;
        const dwarfPath = `${relativeBundle}/Contents/Resources/DWARF/${binaryName}`;
        const absoluteDwarf = join(input.destination, dwarfPath);
        await mkdir(join(absoluteDwarf, ".."), {
          recursive: true,
          mode: 0o700,
        });
        const { sha256, size } = await extract(zip, entry, absoluteDwarf);
        let slices: MachOSlice[];
        try {
          slices = await slicesOf(absoluteDwarf, size);
        } catch (error) {
          failures.push(
            `${bundle.bundleName}/${binaryName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await rm(join(input.destination, id), {
            recursive: true,
            force: true,
          });
          continue;
        }
        let infoPlistPath: string | null = null;
        if (bundle.plist) {
          infoPlistPath = `${relativeBundle}/Contents/Info.plist`;
          await extract(
            zip,
            bundle.plist,
            join(input.destination, infoPlistPath),
          );
        }
        indexed.push({
          id,
          bundleName: bundle.bundleName,
          binaryName,
          // dsymutil writes `com.apple.xcode.dsym.<app bundle ID>`.
          bundleIdentifier:
            plistString(plist, "CFBundleIdentifier")?.replace(
              /^com\.apple\.xcode\.dsym\./,
              "",
            ) ?? null,
          shortVersion: plistString(plist, "CFBundleShortVersionString"),
          bundleVersion: plistString(plist, "CFBundleVersion"),
          dwarfPath,
          dwarfSha256: sha256,
          dwarfSizeBytes: size,
          infoPlistPath,
          slices,
        });
      }
    }
    if (!indexed.length) {
      throw new DsymIndexError(
        `None of the dSYMs could be read. ${failures.join("; ")}`.slice(
          0,
          2_000,
        ),
      );
    }
    return indexed;
  } finally {
    zip.close();
  }
}
