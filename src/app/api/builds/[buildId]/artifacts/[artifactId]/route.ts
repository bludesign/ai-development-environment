import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";

import {
  cancelArtifactTransfer,
  expectArtifactTransfer,
} from "@/services/builds/artifact-transfer";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 180;

function disposition(filename: string): string {
  const safe = filename.replace(/["\r\n]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ buildId: string; artifactId: string }>;
  },
): Promise<Response> {
  const uploadId = randomUUID();
  try {
    const { buildId, artifactId } = await context.params;
    const services = getServerServices();
    const build = await services.buildsService.getBuild(buildId);
    if (!build?.agentId) {
      return new Response("Build agent is unavailable", { status: 409 });
    }
    const transferPromise = expectArtifactTransfer(uploadId, build.agentId);
    const [transfer] = await Promise.all([
      transferPromise,
      services.buildsService.prepareArtifactDownload(
        buildId,
        artifactId,
        uploadId,
      ),
    ]);
    const stream = createReadStream(transfer.path);
    stream.once("close", () => void rm(transfer.path, { force: true }));
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-disposition": disposition(transfer.filename),
        ...(transfer.size === null
          ? {}
          : { "content-length": String(transfer.size) }),
        "content-type": transfer.contentType,
      },
    });
  } catch (error) {
    cancelArtifactTransfer(uploadId, error);
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      return new Response("Artifact not found", { status: 404 });
    }
    if (/offline|unavailable|must be updated/i.test(message)) {
      return new Response(message, { status: 409 });
    }
    console.error("Build artifact download failed:", error);
    return new Response("Could not download artifact", { status: 500 });
  }
}
