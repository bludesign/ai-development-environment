import "server-only";

import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ArtifactTransfer = {
  path: string;
  filename: string;
  contentType: string;
  size: number | null;
};

type PendingTransfer = {
  agentId: string;
  resolve: (transfer: ArtifactTransfer) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const globalTransfers = globalThis as typeof globalThis & {
  buildArtifactTransfers?: Map<string, PendingTransfer>;
};
const transfers =
  globalTransfers.buildArtifactTransfers ??
  (globalTransfers.buildArtifactTransfers = new Map());

export function expectArtifactTransfer(
  uploadId: string,
  agentId: string,
  timeoutMs = 170_000,
): Promise<ArtifactTransfer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      transfers.delete(uploadId);
      reject(new Error("The agent did not upload the artifact in time"));
    }, timeoutMs);
    timeout.unref();
    transfers.set(uploadId, { agentId, resolve, reject, timeout });
  });
}

export function cancelArtifactTransfer(uploadId: string, error: unknown): void {
  const pending = transfers.get(uploadId);
  if (!pending) return;
  transfers.delete(uploadId);
  clearTimeout(pending.timeout);
  pending.reject(error instanceof Error ? error : new Error(String(error)));
}

export async function receiveArtifactTransfer(
  uploadId: string,
  agentId: string,
  request: Request,
): Promise<void> {
  const pending = transfers.get(uploadId);
  if (!pending || pending.agentId !== agentId) {
    throw new Error("Artifact upload is not expected");
  }
  if (!request.body) throw new Error("Artifact upload body is required");
  const path = join(tmpdir(), `ade-build-artifact-upload-${uploadId}`);
  try {
    await pipeline(
      Readable.fromWeb(request.body as never),
      createWriteStream(path, { mode: 0o600 }),
    );
    const encodedFilename =
      request.headers.get("x-artifact-filename") ?? "artifact";
    let filename = "artifact";
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      // Keep the safe fallback filename.
    }
    transfers.delete(uploadId);
    clearTimeout(pending.timeout);
    const contentLength = request.headers.get("content-length");
    pending.resolve({
      path,
      filename,
      contentType:
        request.headers.get("content-type") ?? "application/octet-stream",
      size:
        contentLength !== null && Number.isFinite(Number(contentLength))
          ? Number(contentLength)
          : null,
    });
  } catch (error) {
    await rm(path, { force: true });
    cancelArtifactTransfer(uploadId, error);
    throw error;
  }
}
