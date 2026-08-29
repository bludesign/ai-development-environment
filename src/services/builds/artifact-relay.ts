import "server-only";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { getPrismaClient } from "@/data/prisma-client";
import {
  BUILDS_CHANGED_TOPIC,
  agentEventBus,
  buildTopic,
} from "@/services/agent-control";

import { cacheTransferredArtifact } from "./artifact-cache";

export const ARTIFACT_TRANSFER_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES =
  Number(process.env.ARTIFACT_TRANSFER_MAX_BYTES) || 20 * 1024 ** 3;
const TRANSFER_DIRECTORY =
  process.env.ARTIFACT_TRANSFER_DIRECTORY?.trim() ||
  join(tmpdir(), "ade-build-artifact-transfers");

const globalRelay = globalThis as typeof globalThis & {
  buildArtifactTransferLocks?: Map<string, Promise<void>>;
};
const locks =
  globalRelay.buildArtifactTransferLocks ??
  (globalRelay.buildArtifactTransferLocks = new Map());

async function withTransferLock<T>(id: string, action: () => Promise<T>) {
  while (locks.has(id)) await locks.get(id);
  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(id, lock);
  try {
    return await action();
  } finally {
    if (locks.get(id) === lock) locks.delete(id);
    release();
  }
}

function publish(buildId: string): void {
  agentEventBus.publish(buildTopic(buildId), {
    buildChanged: { id: buildId },
  });
  agentEventBus.publish(BUILDS_CHANGED_TOPIC, {
    buildsChanged: { id: buildId },
  });
}

function safeFilename(value: string): string {
  const result = value.trim();
  if (
    !result ||
    result.length > 255 ||
    basename(result) !== result ||
    result.includes("\0")
  ) {
    throw new Error("Artifact filename is invalid");
  }
  return result;
}

async function transferForAgent(
  transferId: string,
  agentId: string,
  role: "source" | "target" | "either",
) {
  const prisma = await getPrismaClient();
  let transfer = await prisma.buildArtifactTransfer.findUnique({
    where: { id: transferId },
    include: { artifact: { include: { build: true } } },
  });
  if (!transfer) throw new Error("Artifact transfer not found");
  const allowed =
    role === "source"
      ? transfer.sourceAgentId === agentId
      : role === "target"
        ? transfer.targetAgentId === agentId
        : transfer.sourceAgentId === agentId ||
          transfer.targetAgentId === agentId;
  if (!allowed) throw new Error("Artifact transfer belongs to another agent");
  if (
    transfer.expiresAt.getTime() <= Date.now() &&
    !["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"].includes(transfer.status)
  ) {
    transfer = await prisma.buildArtifactTransfer.update({
      where: { id: transfer.id },
      data: {
        status: "EXPIRED",
        error: "Artifact transfer expired",
        finishedAt: new Date(),
      },
      include: { artifact: { include: { build: true } } },
    });
    publish(transfer.artifact.buildId);
  }
  return transfer;
}

export async function buildArtifactTransferStatus(
  transferId: string,
  agentId: string,
) {
  return transferForAgent(transferId, agentId, "either");
}

export async function initializeBuildArtifactTransfer(
  transferId: string,
  agentId: string,
  input: {
    uploadLength: number;
    checksum: string;
    filename: string;
    contentType: string;
  },
) {
  return withTransferLock(transferId, async () => {
    const transfer = await transferForAgent(transferId, agentId, "source");
    if (!["QUEUED", "UPLOADING"].includes(transfer.status)) {
      throw new Error("Artifact transfer is not accepting uploads");
    }
    if (
      !Number.isSafeInteger(input.uploadLength) ||
      input.uploadLength <= 0 ||
      input.uploadLength > MAX_ARTIFACT_BYTES
    ) {
      throw new Error("Artifact upload length is invalid");
    }
    const checksum = input.checksum.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error("Artifact checksum must be SHA-256");
    }
    const filename = safeFilename(input.filename);
    const contentType = input.contentType.trim() || "application/octet-stream";
    if (
      transfer.uploadLength !== null &&
      (transfer.uploadLength !== input.uploadLength ||
        transfer.checksum !== checksum ||
        transfer.filename !== filename)
    ) {
      throw new Error("Artifact upload metadata does not match the transfer");
    }
    await mkdir(TRANSFER_DIRECTORY, { recursive: true, mode: 0o700 });
    const stagingPath = join(TRANSFER_DIRECTORY, `${transfer.id}.upload`);
    let existingBytes = 0;
    try {
      existingBytes = (await stat(stagingPath)).size;
    } catch {
      // A new transfer has no staging file yet.
    }
    if (existingBytes > input.uploadLength) {
      await rm(stagingPath, { force: true });
      existingBytes = 0;
    }
    const disk = await statfs(TRANSFER_DIRECTORY);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (freeBytes < input.uploadLength - existingBytes + 64 * 1024 * 1024) {
      throw new Error(
        "The artifact relay does not have enough free disk space",
      );
    }
    const prisma = await getPrismaClient();
    const updated = await prisma.buildArtifactTransfer.update({
      where: { id: transfer.id },
      data: {
        status: "UPLOADING",
        uploadLength: input.uploadLength,
        uploadOffset: existingBytes,
        checksum,
        filename,
        contentType,
        stagingPath,
        error: null,
      },
      include: { artifact: { include: { build: true } } },
    });
    publish(updated.artifact.buildId);
    return updated;
  });
}

export async function appendBuildArtifactTransferChunk(
  transferId: string,
  agentId: string,
  offset: number,
  bytes: Uint8Array,
) {
  return withTransferLock(transferId, async () => {
    const transfer = await transferForAgent(transferId, agentId, "source");
    if (
      transfer.status !== "UPLOADING" ||
      transfer.uploadLength === null ||
      !transfer.stagingPath
    ) {
      throw new Error("Artifact transfer upload has not been initialized");
    }
    if (!Number.isSafeInteger(offset) || offset !== transfer.uploadOffset) {
      throw new Error(
        `Upload offset mismatch; expected ${transfer.uploadOffset}`,
      );
    }
    if (!bytes.byteLength || bytes.byteLength > ARTIFACT_TRANSFER_CHUNK_BYTES) {
      throw new Error("Artifact upload chunks must be 1 to 16 MiB");
    }
    if (offset + bytes.byteLength > transfer.uploadLength) {
      throw new Error("Artifact upload exceeds its declared length");
    }
    const handle = await open(transfer.stagingPath, offset === 0 ? "w" : "r+");
    try {
      await handle.write(bytes, 0, bytes.byteLength, offset);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const prisma = await getPrismaClient();
    const updated = await prisma.buildArtifactTransfer.update({
      where: { id: transfer.id },
      data: { uploadOffset: offset + bytes.byteLength },
      include: { artifact: { include: { build: true } } },
    });
    publish(updated.artifact.buildId);
    return updated;
  });
}

export async function buildArtifactFileChecksum(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function completeBuildArtifactTransferUpload(
  transferId: string,
  agentId: string,
) {
  return withTransferLock(transferId, async () => {
    const transfer = await transferForAgent(transferId, agentId, "source");
    if (
      transfer.status !== "UPLOADING" ||
      transfer.uploadLength === null ||
      transfer.uploadOffset !== transfer.uploadLength ||
      !transfer.stagingPath ||
      !transfer.checksum ||
      !transfer.filename ||
      !transfer.contentType
    ) {
      throw new Error("Artifact upload is incomplete");
    }
    const actualChecksum = await buildArtifactFileChecksum(
      transfer.stagingPath,
    );
    const prisma = await getPrismaClient();
    if (actualChecksum !== transfer.checksum) {
      await rm(transfer.stagingPath, { force: true });
      const failed = await prisma.buildArtifactTransfer.update({
        where: { id: transfer.id },
        data: {
          status: "FAILED",
          error: "Artifact checksum did not match",
          stagingPath: null,
          finishedAt: new Date(),
        },
        include: { artifact: { include: { build: true } } },
      });
      publish(failed.artifact.buildId);
      throw new Error("Artifact checksum did not match");
    }
    const cached = await cacheTransferredArtifact({
      buildId: transfer.artifact.buildId,
      artifactId: transfer.artifactId,
      path: transfer.stagingPath,
      filename: transfer.filename,
      contentType: transfer.contentType,
    });
    const ready = await prisma.buildArtifactTransfer.update({
      where: { id: transfer.id },
      data: {
        status: "READY",
        stagingPath: cached.path,
        uploadOffset: cached.size,
        uploadLength: cached.size,
        error: null,
      },
      include: { artifact: { include: { build: true } } },
    });
    publish(ready.artifact.buildId);
    return ready;
  });
}

export async function readBuildArtifactTransferRange(
  transferId: string,
  agentId: string,
  start: number,
  end: number,
) {
  const transfer = await transferForAgent(transferId, agentId, "target");
  if (
    !["READY", "DOWNLOADING", "SUCCEEDED"].includes(transfer.status) ||
    !transfer.stagingPath ||
    transfer.uploadLength === null
  ) {
    throw new Error("Artifact transfer is not ready to download");
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= transfer.uploadLength ||
    end - start + 1 > ARTIFACT_TRANSFER_CHUNK_BYTES
  ) {
    throw new Error("Artifact download range is invalid");
  }
  const bytes = Buffer.allocUnsafe(end - start + 1);
  const handle = await open(transfer.stagingPath, "r");
  try {
    const result = await handle.read(bytes, 0, bytes.length, start);
    if (result.bytesRead !== bytes.length) {
      throw new Error("Artifact download ended unexpectedly");
    }
  } finally {
    await handle.close();
  }
  const prisma = await getPrismaClient();
  await prisma.buildArtifactTransfer.update({
    where: { id: transfer.id },
    data: {
      status: transfer.status === "SUCCEEDED" ? "SUCCEEDED" : "DOWNLOADING",
      downloadOffset: Math.max(transfer.downloadOffset, end + 1),
    },
  });
  publish(transfer.artifact.buildId);
  return {
    bytes,
    start,
    end,
    size: transfer.uploadLength,
    checksum: transfer.checksum,
    filename: transfer.filename ?? "artifact.tar.gz",
    contentType: transfer.contentType ?? "application/octet-stream",
  };
}

export async function failBuildArtifactTransferForJob(
  jobId: string,
  error: string,
): Promise<void> {
  const prisma = await getPrismaClient();
  const transfer = await prisma.buildArtifactTransfer.findFirst({
    where: { OR: [{ sourceJobId: jobId }, { targetJobId: jobId }] },
    include: { artifact: true },
  });
  if (!transfer || ["SUCCEEDED", "FAILED"].includes(transfer.status)) return;
  await prisma.$transaction([
    prisma.buildArtifactTransfer.update({
      where: { id: transfer.id },
      data: { status: "FAILED", error, finishedAt: new Date() },
    }),
    prisma.buildDeployment.updateMany({
      where: {
        transferId: transfer.id,
        status: { in: ["QUEUED", "TRANSFERRING"] },
      },
      data: { status: "FAILED", error, finishedAt: new Date() },
    }),
  ]);
  publish(transfer.artifact.buildId);
}
