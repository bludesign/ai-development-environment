import {
  ARTIFACT_TRANSFER_CHUNK_BYTES,
  appendBuildArtifactTransferChunk,
  buildArtifactTransferStatus,
} from "@/services/builds/artifact-relay";
import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

export const runtime = "nodejs";
export const maxDuration = 1800;

async function agentId(request: Request): Promise<string | null> {
  return (await SharedGraphQLServerService.createContext(request.headers))
    .agentId;
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ transferId: string }> },
): Promise<Response> {
  const authenticated = await agentId(request);
  if (!authenticated) return new Response(null, { status: 401 });
  try {
    const { transferId } = await context.params;
    const transfer = await buildArtifactTransferStatus(
      transferId,
      authenticated,
    );
    if (transfer.sourceAgentId !== authenticated)
      return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Upload-Offset": String(transfer.uploadOffset),
        ...(transfer.uploadLength === null
          ? {}
          : { "Upload-Length": String(transfer.uploadLength) }),
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : null, {
      status: 409,
    });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ transferId: string }> },
): Promise<Response> {
  const authenticated = await agentId(request);
  if (!authenticated)
    return new Response("Agent authentication is required", { status: 401 });
  try {
    const contentLength = Number(request.headers.get("content-length"));
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0 ||
      contentLength > ARTIFACT_TRANSFER_CHUNK_BYTES
    ) {
      return new Response("Artifact upload chunks must be 1 to 16 MiB", {
        status: 413,
      });
    }
    const offset = Number(request.headers.get("upload-offset"));
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== contentLength)
      throw new Error("Upload content length did not match");
    const { transferId } = await context.params;
    const transfer = await appendBuildArtifactTransferChunk(
      transferId,
      authenticated,
      offset,
      bytes,
    );
    return new Response(null, {
      status: 204,
      headers: { "Upload-Offset": String(transfer.uploadOffset) },
    });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Artifact upload failed",
      {
        status: 409,
      },
    );
  }
}
