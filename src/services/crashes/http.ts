import "server-only";

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import Busboy from "@fastify/busboy";
import { Zip, ZipDeflate } from "fflate";

import { parseRangeHeader } from "@/lib/http-range";
import type {
  AnonymousPrincipal,
  ApiKeyPrincipal,
  UserPrincipal,
} from "@/services/auth";
import { resolveClientIp } from "@/services/ios-devices/client-ip";

import {
  CRASH_REPORT_MAX_BYTES,
  DSYM_UPLOAD_MAX_BYTES,
  PayloadTooLargeError,
  crashDataPath,
  ensureCrashDataFolder,
  limitedDigest,
} from "./crash-store";
import {
  CrashRequestError,
  type CrashUploader,
  type DsymMetadata,
  type DsymUploader,
} from "./crashes.service";
import { DsymIndexError } from "./dsym-index";
import { CrashParseError } from "./types";

const NO_STORE = { "cache-control": "no-store" };

export function jsonError(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: NO_STORE },
  );
}

/** Maps the errors crash and dSYM handling throw onto HTTP responses. */
export function crashErrorResponse(error: unknown, context: string): Response {
  if (error instanceof CrashParseError) {
    return jsonError(error.status, error.code, error.message);
  }
  if (error instanceof CrashRequestError) {
    return jsonError(error.status, error.code, error.message);
  }
  if (error instanceof PayloadTooLargeError) {
    return jsonError(413, "PAYLOAD_TOO_LARGE", error.message);
  }
  if (error instanceof DsymIndexError) {
    return jsonError(400, "INVALID_DSYM_ARCHIVE", error.message);
  }
  console.error(`${context} failed:`, error);
  return jsonError(500, "INTERNAL_ERROR", "Internal server error");
}

export function crashUploader(
  principal: UserPrincipal | ApiKeyPrincipal | AnonymousPrincipal,
  request: Request,
): CrashUploader {
  return {
    source: principal.kind === "user" ? "UPLOAD" : "API",
    uploadedBy: principal.kind === "user" ? principal.email : null,
    apiKeyId: principal.kind === "apiKey" ? principal.apiKeyId : null,
    apiKeyName: principal.kind === "apiKey" ? principal.name : null,
    clientIp: resolveClientIp(request.headers)?.address ?? null,
  };
}

export function dsymUploader(
  principal: UserPrincipal | ApiKeyPrincipal,
): DsymUploader {
  return principal.kind === "user"
    ? {
        source: "UPLOAD",
        uploadedBy: principal.email,
        apiKeyId: null,
        ownerKey: `user:${principal.userId}`,
      }
    : {
        source: "API",
        uploadedBy: principal.name ? `API key ${principal.name}` : "API key",
        apiKeyId: principal.apiKeyId,
        ownerKey: `api-key:${principal.apiKeyId}`,
      };
}

export function ownerKey(principal: UserPrincipal | ApiKeyPrincipal): string {
  return dsymUploader(principal).ownerKey!;
}

async function collect(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > limit) {
      throw new PayloadTooLargeError("Crash reports may be at most 5 MiB");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

/**
 * Reads a crash report body, decoding `Content-Encoding: gzip`. The 5 MiB cap
 * applies to the decoded bytes, so a small compressed body cannot expand past
 * it.
 */
export async function readCrashBody(request: Request): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > CRASH_REPORT_MAX_BYTES) {
    throw new PayloadTooLargeError("Crash reports may be at most 5 MiB");
  }
  if (!request.body) throw new CrashRequestError("A request body is required");
  const encoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  const source = Readable.fromWeb(request.body as never);
  if (!encoding || encoding === "identity") {
    return collect(source, CRASH_REPORT_MAX_BYTES);
  }
  if (encoding !== "gzip") {
    throw new CrashRequestError(
      "Content-Encoding must be gzip or omitted",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }
  const gunzip = createGunzip();
  source.pipe(gunzip);
  source.on("error", (error) => gunzip.destroy(error));
  try {
    return await collect(gunzip, CRASH_REPORT_MAX_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    throw new CrashRequestError("The gzip body could not be decoded");
  } finally {
    source.destroy();
  }
}

export function crashFilename(request: Request): string | null {
  const header = request.headers.get("x-crash-filename");
  if (!header) return null;
  let decoded = header;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    // Use the header as sent when it is not URI encoded.
  }
  return (
    decoded
      .replace(/[\\/\0\r\n]/g, "_")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 255) || null
  );
}

export type ReceivedZip = {
  path: string;
  filename: string;
  sha256: string;
  size: number;
  metadata: DsymMetadata;
};

const METADATA_FIELDS = ["buildId", "url", "projectName"] as const;

function metadataFrom(source: {
  get(name: string): string | null | undefined;
}): DsymMetadata {
  return Object.fromEntries(
    METADATA_FIELDS.map((name) => [name, source.get(name) ?? null]),
  );
}

/**
 * Streams a one-shot dSYM upload to a staging file: either the `file` part of a
 * multipart form, or a raw zip body with metadata in the query string.
 */
export async function receiveDsymZip(request: Request): Promise<ReceivedZip> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > DSYM_UPLOAD_MAX_BYTES + 65_536) {
    throw new PayloadTooLargeError(
      "The dSYM zip is larger than this server accepts in one request; use the resumable upload",
    );
  }
  if (!request.body) throw new CrashRequestError("A request body is required");
  await ensureCrashDataFolder("dsym-uploads");
  const staging = `dsym-uploads/${randomUUID()}.zip`;
  const path = crashDataPath(staging);
  const contentType = request.headers.get("content-type") ?? "";
  const tooLarge = `dSYM uploads may be at most ${Math.round(DSYM_UPLOAD_MAX_BYTES / 1024 ** 2)} MiB in one request; use the resumable upload for larger zips`;
  try {
    if (/^multipart\/form-data/i.test(contentType)) {
      return await receiveMultipart(request, path, contentType, tooLarge);
    }
    if (
      !/^(application\/(zip|x-zip-compressed|octet-stream))?\s*(;|$)/i.test(
        contentType,
      )
    ) {
      throw new CrashRequestError(
        "Send multipart/form-data with a file part, or an application/zip body",
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      );
    }
    const limiter = limitedDigest(DSYM_UPLOAD_MAX_BYTES, tooLarge);
    await pipeline(
      Readable.fromWeb(request.body as never),
      limiter.transform,
      createWriteStream(path, { mode: 0o600 }),
    );
    const { sha256, size } = limiter.result();
    if (!size) throw new CrashRequestError("The zip is empty");
    const url = new URL(request.url);
    return {
      path,
      filename:
        url.searchParams.get("filename") ??
        crashFilename(request) ??
        "dSYMs.zip",
      sha256,
      size,
      metadata: metadataFrom(url.searchParams),
    };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

function receiveMultipart(
  request: Request,
  path: string,
  contentType: string,
  tooLarge: string,
): Promise<ReceivedZip> {
  return new Promise((resolve, reject) => {
    const fields = new Map<string, string>();
    let file: Promise<{
      sha256: string;
      size: number;
      filename: string;
    }> | null = null;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let parser;
    try {
      parser = Busboy({
        headers: { "content-type": contentType },
        limits: {
          files: 1,
          fields: 10,
          fieldSize: 4_096,
          fileSize: DSYM_UPLOAD_MAX_BYTES,
          parts: 12,
        },
      });
    } catch {
      fail(new CrashRequestError("The multipart body is malformed"));
      return;
    }
    parser.on("field", (name, value) => {
      if (METADATA_FIELDS.includes(name as (typeof METADATA_FIELDS)[number])) {
        fields.set(name, value);
      }
    });
    parser.on("file", (name, stream, filename) => {
      if (name !== "file" || file) {
        stream.resume();
        return;
      }
      const limiter = limitedDigest(DSYM_UPLOAD_MAX_BYTES, tooLarge);
      stream.on("limit", () =>
        stream.destroy(new PayloadTooLargeError(tooLarge)),
      );
      file = pipeline(
        stream,
        limiter.transform,
        createWriteStream(path, { mode: 0o600 }),
      ).then(() => ({ ...limiter.result(), filename }));
      file.catch(fail);
    });
    parser.on("error", (error) =>
      fail(
        error instanceof Error &&
          /Unexpected end|Malformed/i.test(error.message)
          ? new CrashRequestError("The multipart body is malformed")
          : error,
      ),
    );
    parser.on("finish", () => {
      if (!file) {
        fail(new CrashRequestError('The form needs a "file" part'));
        return;
      }
      file
        .then((received) => {
          if (settled) return;
          if (!received.size) {
            fail(new CrashRequestError("The zip is empty"));
            return;
          }
          settled = true;
          resolve({
            path,
            filename: received.filename || "dSYMs.zip",
            sha256: received.sha256,
            size: received.size,
            metadata: metadataFrom(fields),
          });
        })
        .catch(fail);
    });
    const body = Readable.fromWeb(request.body as never);
    body.on("error", fail);
    body.pipe(parser);
  });
}

/** Streams a stored file, honoring a single byte range. */
export async function fileResponse(
  request: Request,
  input: {
    path: string;
    filename: string;
    contentType: string;
    expectedSize?: number;
  },
): Promise<Response> {
  let size: number;
  try {
    size = (await stat(input.path)).size;
  } catch {
    return jsonError(410, "GONE", "The stored file is unavailable");
  }
  if (input.expectedSize !== undefined && size !== input.expectedSize) {
    return jsonError(410, "GONE", "The stored file failed verification");
  }
  const headers: Record<string, string> = {
    "content-type": input.contentType,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(input.filename)}`,
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    ...NO_STORE,
  };
  const range = parseRangeHeader(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const stream =
    size === 0
      ? Readable.from([])
      : createReadStream(input.path, { start, end });
  return new Response(Readable.toWeb(stream) as BodyInit, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "content-length": String(size === 0 ? 0 : end - start + 1),
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}

/** Zips files on the fly, so a dSYM bundle downloads as one file. */
export function zipResponse(
  filename: string,
  files: { name: string; path: string }[],
): Response {
  async function* chunks() {
    const queue: Uint8Array[] = [];
    let failure: Error | null = null;
    const zip = new Zip((error, data) => {
      if (error) failure = error;
      else queue.push(data);
    });
    for (const file of files) {
      const entry = new ZipDeflate(file.name, { level: 6 });
      zip.add(entry);
      for await (const chunk of createReadStream(file.path)) {
        entry.push(chunk as Buffer);
        if (failure) throw failure;
        while (queue.length) yield queue.shift()!;
      }
      entry.push(new Uint8Array(0), true);
      while (queue.length) yield queue.shift()!;
    }
    zip.end();
    if (failure) throw failure;
    while (queue.length) yield queue.shift()!;
  }
  return new Response(Readable.toWeb(Readable.from(chunks())) as BodyInit, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "x-content-type-options": "nosniff",
      ...NO_STORE,
    },
  });
}

export { NO_STORE };

type UploadWithDsyms = {
  id: string;
  status: string;
  buildId: string | null;
  url: string | null;
  projectName: string | null;
  dsyms: {
    id: string;
    bundleName: string;
    shortVersion: string | null;
    bundleVersion: string | null;
    slices: { uuid: string; arch: string }[];
  }[];
};

function dashed(uuid: string): string {
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

/** The body every dSYM upload endpoint answers with, UUIDs as Xcode prints them. */
export function dsymUploadBody(upload: UploadWithDsyms, duplicate: boolean) {
  return {
    duplicate,
    upload: {
      id: upload.id,
      status: upload.status,
      buildId: upload.buildId,
      url: upload.url,
      projectName: upload.projectName,
    },
    dsyms: upload.dsyms.map((dsym) => ({
      id: dsym.id,
      bundleName: dsym.bundleName,
      version: dsym.shortVersion,
      build: dsym.bundleVersion,
      url: `/crashes/dsyms/${dsym.id}`,
      slices: dsym.slices.map((slice) => ({
        uuid: dashed(slice.uuid),
        arch: slice.arch,
      })),
    })),
  };
}
