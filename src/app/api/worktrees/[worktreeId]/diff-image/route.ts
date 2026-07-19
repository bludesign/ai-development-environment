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
export const maxDuration = 90;

const SCOPES = new Set(["STAGED", "UNSTAGED", "UNTRACKED", "COMMIT", "BRANCH"]);

export async function GET(
  request: Request,
  context: { params: Promise<{ worktreeId: string }> },
): Promise<Response> {
  const uploadId = randomUUID();
  try {
    const { worktreeId } = await context.params;
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const path = url.searchParams.get("path");
    const side = url.searchParams.get("side");
    const commitSha = url.searchParams.get("commitSha");
    if (
      !scope ||
      !SCOPES.has(scope) ||
      !path ||
      (side !== "BEFORE" && side !== "AFTER")
    ) {
      return new Response("Invalid diff image request", { status: 400 });
    }
    const services = getServerServices();
    const agentId =
      await services.worktreesService.diffAssetAgentId(worktreeId);
    if (!agentId) return new Response("Worktree not found", { status: 404 });
    const transferPromise = expectArtifactTransfer(uploadId, agentId);
    const [transfer] = await Promise.all([
      transferPromise,
      services.worktreesService.prepareDiffAsset(
        worktreeId,
        {
          scope: scope as never,
          path,
          commitSha,
          side,
        },
        uploadId,
      ),
    ]);
    const stream = createReadStream(transfer.path);
    stream.once("close", () => void rm(transfer.path, { force: true }));
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "cache-control": "private, no-store",
        ...(transfer.size === null
          ? {}
          : { "content-length": String(transfer.size) }),
        "content-type": transfer.contentType,
      },
    });
  } catch (error) {
    cancelArtifactTransfer(uploadId, error);
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|unavailable/i.test(message)) {
      return new Response(message, { status: 404 });
    }
    if (/offline|updated|active/i.test(message)) {
      return new Response(message, { status: 409 });
    }
    console.error("Worktree diff image failed:", error);
    return new Response("Could not load diff image", { status: 500 });
  }
}
