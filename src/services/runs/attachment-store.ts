import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  getPrismaClient,
  sqlitePathFromDatabaseUrl,
} from "@/data/prisma-client";

export const MAX_RUN_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RUN_INPUT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function cleanFilename(value: string | null): string {
  const fallback = "attachment";
  if (!value) return fallback;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Use the original header when it is not URI encoded.
  }
  const cleaned = decoded
    .replace(/[\\/\0\r\n]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned || fallback).slice(0, 255);
}

export function runDataDirectory(): string {
  if (process.env.RUN_DATA_DIRECTORY) {
    return resolve(process.env.RUN_DATA_DIRECTORY);
  }
  const databaseUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";
  return join(
    dirname(resolve(sqlitePathFromDatabaseUrl(databaseUrl))),
    "run-data",
  );
}

export async function storeRunAttachment(request: Request) {
  void removeOrphanRunAttachments().catch(() => undefined);
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RUN_ATTACHMENT_BYTES
  ) {
    throw new Error("Attachment exceeds the 25 MB file limit");
  }
  if (!request.body) throw new Error("Attachment body is required");

  const id = randomUUID();
  const directory = join(runDataDirectory(), "attachments");
  const destination = join(directory, id);
  const temporary = `${destination}.upload`;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const digest = createHash("sha256");
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_RUN_ATTACHMENT_BYTES) {
        callback(new Error("Attachment exceeds the 25 MB file limit"));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body as never),
      limiter,
      createWriteStream(temporary, { mode: 0o600 }),
    );
    await rename(temporary, destination);
    const prisma = await getPrismaClient();
    return await prisma.runAttachment.create({
      data: {
        id,
        sha256: digest.digest("hex"),
        filename: cleanFilename(request.headers.get("x-attachment-filename")),
        contentType:
          request.headers.get("content-type") || "application/octet-stream",
        size,
        storagePath: destination,
      },
    });
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(destination, { force: true });
    throw error;
  }
}

export async function runAttachmentResponse(
  id: string,
  agentId?: string,
): Promise<Response> {
  const prisma = await getPrismaClient();
  const attachment = await prisma.runAttachment.findUnique({
    where: { id },
    include: {
      input: { include: { run: { select: { agentId: true } } } },
      draft: { select: { agentId: true } },
    },
  });
  if (!attachment) return new Response("Attachment not found", { status: 404 });
  if (
    agentId &&
    attachment.input?.run.agentId !== agentId &&
    attachment.draft?.agentId !== agentId
  ) {
    return new Response("Attachment does not belong to this agent", {
      status: 403,
    });
  }
  try {
    const attachmentRoot = resolve(runDataDirectory(), "attachments");
    const storagePath = resolve(attachment.storagePath);
    if (!storagePath.startsWith(`${attachmentRoot}${sep}`)) {
      return new Response("Attachment path is invalid", { status: 410 });
    }
    const information = await stat(storagePath);
    if (information.size !== attachment.size) {
      return new Response("Attachment data failed verification", {
        status: 410,
      });
    }
    const stream = Readable.toWeb(createReadStream(storagePath));
    return new Response(stream as BodyInit, {
      headers: {
        "content-type": attachment.contentType,
        "content-length": String(information.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Attachment data is unavailable", { status: 410 });
  }
}

export async function cloneRunAttachments(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const prisma = await getPrismaClient();
  const attachments = await prisma.runAttachment.findMany({
    where: { id: { in: ids } },
  });
  if (attachments.length !== ids.length)
    throw new Error("Attachment is unavailable");
  const directory = resolve(runDataDirectory(), "attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const created: Array<{ id: string; path: string }> = [];
  try {
    for (const source of attachments) {
      const id = randomUUID();
      const storagePath = join(directory, id);
      await copyFile(source.storagePath, storagePath);
      await prisma.runAttachment.create({
        data: {
          id,
          sha256: source.sha256,
          filename: source.filename,
          contentType: source.contentType,
          size: source.size,
          storagePath,
        },
      });
      created.push({ id, path: storagePath });
    }
    return created.map(({ id }) => id);
  } catch (error) {
    await prisma.runAttachment.deleteMany({
      where: { id: { in: created.map(({ id }) => id) } },
    });
    await removeRunAttachmentFiles(created.map(({ path }) => path));
    throw error;
  }
}

export async function removeRunAttachmentFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

export async function removeOrphanRunAttachments(
  olderThan = new Date(Date.now() - 24 * 60 * 60 * 1_000),
): Promise<number> {
  const prisma = await getPrismaClient();
  const orphans = await prisma.runAttachment.findMany({
    where: { inputId: null, draftId: null, createdAt: { lt: olderThan } },
  });
  if (!orphans.length) return 0;
  await prisma.runAttachment.deleteMany({
    where: { id: { in: orphans.map(({ id }) => id) } },
  });
  await removeRunAttachmentFiles(orphans.map(({ storagePath }) => storagePath));
  return orphans.length;
}
