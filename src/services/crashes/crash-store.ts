import "server-only";

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { sqlitePathFromDatabaseUrl } from "@/data/prisma-client";

/** Largest crash report body, after gzip decoding. */
export const CRASH_REPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Largest dSYM zip accepted in one request. */
export const DSYM_UPLOAD_MAX_BYTES =
  Number(process.env.DSYM_UPLOAD_MAX_BYTES) || 2 * 1024 ** 3;
/** Largest dSYM zip accepted through the resumable protocol. */
export const DSYM_RESUMABLE_MAX_BYTES = 20 * 1024 ** 3;
/** Chunk size of the resumable protocol, the same as build artifact relays. */
export const DSYM_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  readonly status = 413;
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Where crash reports and extracted dSYMs live: `CRASH_DATA_DIRECTORY`, or a
 * `crash-data` folder next to the SQLite database so backups of that folder
 * pick it up.
 */
export function crashDataDirectory(): string {
  if (process.env.CRASH_DATA_DIRECTORY) {
    return resolve(process.env.CRASH_DATA_DIRECTORY);
  }
  const databaseUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";
  return join(
    dirname(resolve(sqlitePathFromDatabaseUrl(databaseUrl))),
    "crash-data",
  );
}

/**
 * Resolves a stored relative path, refusing anything that would land outside
 * the crash data folder.
 */
export function crashDataPath(relativePath: string): string {
  const root = crashDataDirectory();
  if (isAbsolute(relativePath)) throw new Error("Crash data path is invalid");
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${sep}`)) {
    throw new Error("Crash data path is invalid");
  }
  return absolute;
}

export function toCrashDataRelative(absolutePath: string): string {
  const path = relative(crashDataDirectory(), absolutePath);
  if (path.startsWith("..") || isAbsolute(path)) {
    throw new Error("Crash data path is invalid");
  }
  return path.split(sep).join("/");
}

export async function ensureCrashDataFolder(
  relativePath: string,
): Promise<string> {
  const folder = crashDataPath(relativePath);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return folder;
}

export function limitedDigest(limit: number, message: string) {
  const digest = createHash("sha256");
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        callback(new PayloadTooLargeError(message));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    transform,
    result: () => ({ sha256: digest.digest("hex"), size }),
  };
}

/**
 * Streams a body into the crash data folder: a `.upload` file first, renamed
 * into place only once the whole body arrived within the limit.
 */
export async function writeCrashData(
  relativePath: string,
  source: Readable | ReadableStream<Uint8Array>,
  limit: number,
  limitMessage: string,
): Promise<{ sha256: string; size: number; absolutePath: string }> {
  const destination = crashDataPath(relativePath);
  const temporary = `${destination}.upload`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const limiter = limitedDigest(limit, limitMessage);
  try {
    await pipeline(
      source instanceof Readable ? source : Readable.fromWeb(source as never),
      limiter.transform,
      createWriteStream(temporary, { mode: 0o600 }),
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(destination, { force: true });
    throw error;
  }
  return { ...limiter.result(), absolutePath: destination };
}

/** Writes a small body that is already in memory, such as a crash report. */
export async function writeCrashBytes(
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const destination = crashDataPath(relativePath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { mode: 0o600 });
}

/**
 * The folder holding one extracted dSYM, `dsyms/<uploadId>/<dsymId>`, derived
 * from its DWARF path.
 */
export function dsymFolder(dwarfPath: string): string {
  return dwarfPath.split("/").slice(0, 3).join("/");
}

export async function removeCrashData(
  relativePath: string | null | undefined,
): Promise<void> {
  if (!relativePath) return;
  try {
    await rm(crashDataPath(relativePath), { recursive: true, force: true });
  } catch {
    // A missing or invalid path has nothing left to remove.
  }
}

export async function fileSha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

/** Size of a stored file, or null when it is missing. */
export async function storedSize(relativePath: string): Promise<number | null> {
  try {
    return (await stat(crashDataPath(relativePath))).size;
  } catch {
    return null;
  }
}
