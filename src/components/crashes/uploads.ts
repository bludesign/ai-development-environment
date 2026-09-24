"use client";

import { Zip, ZipDeflate } from "fflate";

/** Chunk size of the resumable dSYM protocol. */
const CHUNK_BYTES = 16 * 1024 * 1024;
const CHUNK_ATTEMPTS = 4;

export type CrashUploadResult = {
  duplicate: boolean;
  crashes: { id: string; status: string; url: string }[];
};

export type DsymUploadResult = {
  duplicate: boolean;
  upload: { id: string; status: string };
  dsyms: {
    id: string;
    bundleName: string;
    version: string | null;
    build: string | null;
    url: string;
    slices: { uuid: string; arch: string }[];
  }[];
};

export type DsymMetadata = {
  projectName?: string;
  buildId?: string;
  url?: string;
};

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
    };
    if (typeof body.error === "string") return body.error;
    if (body.error?.message) return body.error.message;
  } catch {
    // Fall through to the status text.
  }
  return `HTTP ${response.status}`;
}

export function crashContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ips") || lower.endsWith(".json")) {
    return "application/json";
  }
  if (lower.endsWith(".crash") || lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

export async function uploadCrashReport(
  file: File,
  signal?: AbortSignal,
): Promise<CrashUploadResult> {
  const response = await fetch("/api/crashes", {
    method: "POST",
    body: file,
    headers: {
      "content-type": crashContentType(file.name),
      "x-crash-filename": encodeURIComponent(file.name),
    },
    signal,
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as CrashUploadResult;
}

export type DroppedFile = { file: File; path: string };

async function walk(entry: FileSystemEntry, into: DroppedFile[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    into.push({ file, path: entry.fullPath.replace(/^\//, "") });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns results in batches until it returns an empty one.
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) break;
    for (const child of batch) await walk(child, into);
  }
}

/**
 * Reads what was dropped, descending into folders. A `.dSYM` or `.xcarchive`
 * is a folder in Finder, so dragging one gives a directory entry rather than a
 * file.
 */
export async function collectDroppedFiles(
  transfer: DataTransfer,
): Promise<DroppedFile[]> {
  const entries = Array.from(transfer.items ?? [])
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (!entries.length) {
    return Array.from(transfer.files).map((file) => ({
      file,
      path: file.name,
    }));
  }
  const files: DroppedFile[] = [];
  for (const entry of entries) await walk(entry, files);
  return files;
}

/**
 * Picks the files that belong in a dSYM zip and names them from the bundle
 * down, so `App.xcarchive/dSYMs/App.app.dSYM/...` becomes `App.app.dSYM/...`.
 * Everything else in an archive, and macOS metadata files, is left out.
 */
export function dsymZipEntries(
  files: DroppedFile[],
): { name: string; file: File }[] {
  const result: { name: string; file: File }[] = [];
  for (const { file, path } of files) {
    const parts = path.split("/");
    const bundle = parts.findIndex((part) => part.endsWith(".dSYM"));
    if (bundle < 0) continue;
    const leaf = parts[parts.length - 1]!;
    if (leaf.startsWith("._") || leaf === ".DS_Store") continue;
    result.push({ name: parts.slice(bundle).join("/"), file });
  }
  return result;
}

/**
 * Zips dropped dSYM bundles in the browser. Entries are read one at a time and
 * compressed as they stream, so only the compressed output is held in memory.
 */
export async function zipDsymBundles(
  entries: { name: string; file: File }[],
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let failure: Error | null = null;
  let finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) failure = error;
    else chunks.push(data as Uint8Array<ArrayBuffer>);
    if (final) finished = true;
  });
  const total = entries.reduce((sum, entry) => sum + entry.file.size, 0) || 1;
  let read = 0;
  for (const entry of entries) {
    const deflate = new ZipDeflate(entry.name, { level: 6 });
    zip.add(deflate);
    const reader = entry.file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      deflate.push(value);
      read += value.byteLength;
      onProgress?.(read / total);
      if (failure) throw failure;
    }
    deflate.push(new Uint8Array(0), true);
  }
  zip.end();
  if (failure) throw failure;
  if (!finished) throw new Error("The dSYM zip could not be finished");
  return new Blob(chunks, { type: "application/zip" });
}

async function withRetries<T>(
  attempt: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < CHUNK_ATTEMPTS; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(4_000, 500 * 2 ** index)),
      );
    }
  }
  throw lastError;
}

/**
 * Uploads a dSYM zip through the resumable protocol, so large zips get past
 * proxies with request size limits and a dropped connection resumes from the
 * last chunk rather than the start.
 */
export async function uploadDsymZip(
  blob: Blob,
  filename: string,
  metadata: DsymMetadata,
  {
    onProgress,
    signal,
  }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<DsymUploadResult> {
  const started = await fetch("/api/dsyms/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename,
      sizeBytes: blob.size,
      buildId: metadata.buildId || null,
      url: metadata.url || null,
      projectName: metadata.projectName || null,
    }),
    signal,
  });
  if (!started.ok) throw new Error(await errorMessage(started));
  const { id } = (await started.json()) as { id: string };
  const path = `/api/dsyms/uploads/${encodeURIComponent(id)}`;
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + CHUNK_BYTES);
    const start = offset;
    offset = await withRetries(async () => {
      const response = await fetch(path, {
        method: "PATCH",
        headers: {
          "content-type": "application/offset+octet-stream",
          "upload-offset": String(start),
        },
        body: blob.slice(start, end),
        signal,
      });
      if (response.status === 409) {
        // The server has a different offset, such as after a retried chunk
        // that did land. Ask where to continue from.
        const status = await fetch(path, { method: "HEAD", signal });
        const current = Number(status.headers.get("upload-offset"));
        if (status.ok && Number.isSafeInteger(current)) return current;
      }
      if (!response.ok) throw new Error(await errorMessage(response));
      return Number(response.headers.get("upload-offset") ?? end);
    }, signal);
    onProgress?.(offset / blob.size);
  }
  const completed = await fetch(`${path}/complete`, { method: "POST", signal });
  if (!completed.ok) throw new Error(await errorMessage(completed));
  return (await completed.json()) as DsymUploadResult;
}

export function formatBytes(value: number, locale = "en"): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    value / 1024 ** index,
  )} ${units[index]}`;
}
